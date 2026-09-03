// The sole authorizer — `can(actor, action, resource)` (LINA-143; Auth Bridge §3/§4).
//
// This is the framework-agnostic heart of the authorization plane. Following the
// ADR-0004 principle carried forward by the Auth Bridge, it is THE single place
// a capability decision is made, and it is deny-by-default.
//
// Contract:
//   can(actor, action, resource) -> { allow: true } | { allow: false, reason }
//
//   actor    — the resolved acting user: { userId, clerkUserId, activeOrgId }.
//              Derived ONLY from the verified Clerk token, never the request body.
//   action   — a permission verb from the canonical catalogue (see PERMISSIONS).
//   resource — optional resource context: { type, id, ...payload used by runtime
//              predicates (e.g. the change-order proposer) }.
//
// It is PURE: it takes the already-resolved membership (role) and resource-level
// overrides as inputs rather than reading the DB, so it is directly and
// adversarially testable, and a thin resolver (the auth service) feeds it the
// rows from the `authz` catalog. Keeping the decision pure is what lets the
// adversarial tests attack the rule itself.
//
// EVALUATION ORDER (Auth Bridge §4):
//   1. resource_acls deny          → deny (always wins)
//   2. resource_acls allow         → allow (explicit per-resource grant)
//   3. role/permission grant       → allow
//   4. (everything else)           → deny by default
//
// MANDATORY RUNTIME PREDICATE (Architect LINA-142 §8.1 merge gate):
// `change_order.decide` is NOT a pure static grant. Even when the actor's role
// grants `change_order.decide` and no ACL denies it, `can()` MUST still enforce
// the two-sided rule: a change order may be decided by anyone EXCEPT its own
// proposer (owner included). This mirrors services/identity/authz.mjs L103–110
// and is reinforced by the DB CHECK (decided_by <> proposed_by). Absent this
// predicate, the product's core trust promise breaks — LINA-143 is rejected at
// merge without it.

// The canonical, namespaced verb catalogue (mirrors the `authz.permissions`
// seed). A frozen enum (not free strings) so a typo'd action fails loudly here
// instead of silently granting or denying.
export const PERMISSION = Object.freeze({
  PROJECT_CREATE: 'project.create',
  PROJECT_READ: 'project.read',
  PROJECT_UPDATE: 'project.update',
  PROJECT_DELETE: 'project.delete',
  PROJECT_INVITE: 'project.invite',
  MEMBER_INVITE: 'member.invite',
  DECISION_CREATE: 'decision.create',
  DECISION_READ: 'decision.read',
  CHANGE_ORDER_CREATE: 'change_order.create',
  CHANGE_ORDER_READ: 'change_order.read',
  CHANGE_ORDER_DECIDE: 'change_order.decide',
  BUDGET_READ: 'budget.read',
  SCHEDULE_READ: 'schedule.read',
  SCHEDULE_UPDATE: 'schedule.update',
  TASK_ASSIGN: 'task.assign',
  PROGRESS_REPORT: 'progress.report',
  PLAN_UPLOAD: 'plan.upload',
});

/**
 * @typedef {Object} Actor
 * @property {string} userId          local `authz.users.id` (the resolved row)
 * @property {string} [clerkUserId]   Clerk subject
 * @property {string} [activeOrgId]   local `authz.orgs.id` from the token's org
 *
 * @typedef {Object} Resource
 * @property {string} type            resource_type, e.g. 'project' | 'change_order'
 * @property {string} [id]            resource_id for resource_acls lookups
 * @property {string} [proposedBy]    actor.userId of the change-order proposer
 *                                     (used by the two-sided rule)
 *
 * @typedef {Object} MembershipGrant
 * @property {string} roleId    local role id
 * @property {string} roleKey   role key ('owner' | 'gc' | 'subcontractor')
 */

/**
 * The pure authorization decision.
 *
 * @param {Object} ctx
 * @param {Actor} ctx.actor
 * @param {string} ctx.action                    one of PERMISSION.*
 * @param {Resource} [ctx.resource]              resource context (required for scoped verbs)
 * @param {MembershipGrant|null} [ctx.membership] the actor's role on the active org,
 *                                                or null when they have no membership
 * @param {string[]} [ctx.rolePermissions]        permission keys granted by that role
 * @param {Array<{permissionId?:string,key?:string,effect:string}>} [ctx.resourceAcls]
 *                                                resource-level overrides for (actor, resource)
 * @param {string} [ctx.resourceType]             alias for resource.type when no resource object
 * @returns {{ allow: boolean, reason?: string }}
 */
export function can({
  actor,
  action,
  resource,
  membership = null,
  rolePermissions = [],
  resourceAcls = [],
}) {
  if (!actor?.userId) return deny('no acting user');
  if (!Object.values(PERMISSION).includes(action)) {
    return deny(`unknown action "${action}"`);
  }

  // ── project.create is the bootstrap exception (no prior membership) ──────────
  // Architecture §8.1: the creator becomes the owner; there is no membership to
  // check first (mirrors identity authz.mjs L91).
  if (action === PERMISSION.PROJECT_CREATE) return { allow: true };

  // ── Resource-level overrides (evaluation order steps 1–2) ───────────────────
  const scoped = resourceAcls.filter((a) =>
    a.key === action || a.permissionId === action,
  );
  // Deny always wins.
  if (scoped.some((a) => a.effect === 'deny')) {
    return deny(`resource ACL denies ${action}`);
  }
  if (scoped.some((a) => a.effect === 'allow')) {
    return { allow: true };
  }

  // ── Role grant (evaluation order step 3) ─────────────────────────────────────
  // No membership on this org ⇒ not a member ⇒ denies everything (except the
  // bootstrap action handled above).
  if (!membership) return deny('not a member of the active org');
  if (!rolePermissions.includes(action)) {
    return deny(`role "${membership.roleKey}" cannot ${action}`);
  }

  // ── MANDATORY runtime predicate: the two-sided change-order rule (step 3.5) ──
  // Even though the role statically grants change_order.decide, the ACTING user
  // may not decide a change order they themselves proposed. The predicate needs
  // the resource's proposer; without it we cannot evaluate the rule, so we fail
  // closed (deny) rather than silently allow.
  if (action === PERMISSION.CHANGE_ORDER_DECIDE) {
    if (!resource?.proposedBy) {
      return deny('proposer unknown — cannot evaluate the two-sided rule');
    }
    if (actor.userId === resource.proposedBy) {
      return deny('the proposer of a change order cannot decide it');
    }
  }

  return { allow: true };
}

function deny(reason) {
  return { allow: false, reason };
}
