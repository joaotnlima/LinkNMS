// The sole authorizer (ADR-0004).
//
// This is the one place capability decisions are made. Every mutating handler in
// every service calls `can(...)` FIRST, before touching data. Authorization is a
// property of the party's `membership` (party × project × role) — never of the
// user globally, and never trusted from the request body. R0 caps roles to
// `owner` (homeowner) and `counterparty` (GC); adding `sub`, `inspector`, … later
// is new role values + rows in the table below, not a model change.
//
// This module is deliberately PURE: given a role (and, for the two-sided rule,
// the proposer) it returns a decision. The Identity service wraps it with the
// server-side membership lookup (see identity.mjs `authorize`) so the acting
// party is always derived from the session. Keeping the decision pure is what
// lets the adversarial tests attack the rule directly.

/** @typedef {'owner' | 'counterparty'} Role */

// The catalogue of authorizable actions. Using a frozen enum (not free strings
// at call sites) means a typo'd action fails loudly here instead of silently
// granting or denying. Grouped by the service that performs them.
export const ACTION = Object.freeze({
  // Identity & Membership (this slice)
  CREATE_PROJECT: 'create_project',
  INVITE_COUNTERPARTY: 'invite_counterparty',
  VIEW_PROJECT: 'view_project',
  // Decision Log (Slice 3)
  RECORD_DECISION: 'record_decision',
  REVISE_DECISION: 'revise_decision',
  // Change Order (Slice 4)
  PROPOSE_CHANGE_ORDER: 'propose_change_order',
  DECIDE_CHANGE_ORDER: 'decide_change_order',
  // Schedule & Progress (Slice 6) — the GC owns the plan, the homeowner views it
  ADD_STAGE: 'add_stage',
  UPDATE_STAGE: 'update_stage',
  REPORT_PROGRESS: 'report_progress',
  UPLOAD_PLAN_DOCUMENT: 'upload_plan_document',
});

const ALL_ACTIONS = new Set(Object.values(ACTION));

// Role → capability set (ADR-0004 capability table). "any member" actions live
// in both sets; owner-only / counterparty-only actions live in one. `create_project`
// is intentionally absent: it needs no prior membership (see `can`).
const OWNER = new Set([
  ACTION.INVITE_COUNTERPARTY,
  ACTION.VIEW_PROJECT,
  ACTION.RECORD_DECISION,
  ACTION.REVISE_DECISION,
  ACTION.PROPOSE_CHANGE_ORDER,
  ACTION.DECIDE_CHANGE_ORDER, // "owner may always decide" — still subject to ≠ proposer below
]);

const COUNTERPARTY = new Set([
  ACTION.VIEW_PROJECT,
  ACTION.RECORD_DECISION,
  ACTION.REVISE_DECISION,
  ACTION.PROPOSE_CHANGE_ORDER,
  ACTION.DECIDE_CHANGE_ORDER,
  ACTION.ADD_STAGE,
  ACTION.UPDATE_STAGE,
  ACTION.REPORT_PROGRESS,
  ACTION.UPLOAD_PLAN_DOCUMENT,
]);

const CAPABILITIES = { owner: OWNER, counterparty: COUNTERPARTY };

/**
 * @typedef {Object} Decision
 * @property {boolean} allow
 * @property {string} [reason]  present iff denied
 */

/**
 * The pure authorization decision.
 *
 * @param {Object} ctx
 * @param {string} ctx.action          one of ACTION.*
 * @param {Role|null} ctx.role         the acting party's role on the project, or
 *                                     null when they have no membership (non-member)
 * @param {string} [ctx.actorPartyId]  required for DECIDE_CHANGE_ORDER
 * @param {string} [ctx.proposedByPartyId] the CO proposer, for the two-sided rule
 * @returns {Decision}
 */
export function can({ action, role, actorPartyId, proposedByPartyId }) {
  if (!ALL_ACTIONS.has(action)) {
    return deny(`unknown action "${action}"`);
  }

  // Creating a project needs an authenticated party but no prior membership —
  // the creator becomes the owner. Membership-based rules don't apply.
  if (action === ACTION.CREATE_PROJECT) return { allow: true };

  // No membership on this project ⇒ not a member ⇒ sees/does nothing (403).
  if (!role) return deny('not a member of this project');

  const caps = CAPABILITIES[role];
  if (!caps) return deny(`unknown role "${role}"`);
  if (!caps.has(action)) return deny(`role "${role}" cannot ${action}`);

  // The load-bearing FR4 invariant: a change order may be decided by anyone
  // EXCEPT its proposer (owner included). This is enforced here AND by a DB
  // CHECK (decided_by <> proposed_by) — code and schema, two layers.
  if (action === ACTION.DECIDE_CHANGE_ORDER) {
    if (!proposedByPartyId) {
      return deny('proposer unknown — cannot evaluate the two-sided rule');
    }
    if (actorPartyId && actorPartyId === proposedByPartyId) {
      return deny('the proposer of a change order cannot decide it');
    }
  }

  return { allow: true };
}

function deny(reason) {
  return { allow: false, reason };
}
