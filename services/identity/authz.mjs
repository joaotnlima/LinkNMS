// The sole authorizer (ADR-0004).
//
// This is the one place capability decisions are made. Every mutating handler in
// every service calls `can(...)` FIRST, before touching data. Authorization is a
// property of the party's `membership` (party × project × role) — never of the
// user globally, and never trusted from the request body. R0 caps roles to
// `owner` (homeowner) and `counterparty` (GC); `subcontractor` joins with 0009
// (Band B, ADR-0011) as a read-only member of the build's own slice; adding more
// roles later is new role values + rows in the table below, not a model change.
//
// This module is deliberately PURE: given a role (and, for the two-sided rule,
// the proposer) it returns a decision. The Identity service wraps it with the
// server-side membership lookup (see identity.mjs `authorize`) so the acting
// party is always derived from the session. Keeping the decision pure is what
// lets the adversarial tests attack the rule directly.

/** @typedef {'owner' | 'counterparty' | 'subcontractor'} Role */

// The catalogue of authorizable actions. Using a frozen enum (not free strings
// at call sites) means a typo'd action fails loudly here instead of silently
// granting or denying. Grouped by the service that performs them.
export const ACTION = Object.freeze({
  // Identity & Membership (this slice)
  CREATE_PROJECT: 'create_project',
  INVITE_COUNTERPARTY: 'invite_counterparty',
  SET_OPERATING_MODEL: 'set_operating_model',
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
  // Slice B1 plan import (LINA-199, contract §5): GC/counterparty only.
  IMPORT_PLAN: 'import_plan',
  UPLOAD_PLAN_DOCUMENT: 'upload_plan_document',
  // Slice B2 plan baseline (LINA-200, contract §6): either project party may
  // PROPOSE_PLAN (author) or REVIEW_PLAN (the other party's proposal). The actor-vs-
  // proposer pairing is resolved from the plan version row by the schedule service;
  // `can` enforces the two-sided rule that a party may not review its own proposal.
  PROPOSE_PLAN: 'propose_plan',
  REVIEW_PLAN: 'review_plan',
  // Slice B3 materials & movement (LINA-217, contract §4): GC/counterparty records
  // a post-baseline material movement (swap). A scope_change opens a change order
  // that carries its own two-sided approval.
  RECORD_MOVEMENT: 'record_movement',
});

const ALL_ACTIONS = new Set(Object.values(ACTION));

// Role → capability set (ADR-0004 capability table). "any member" actions live
// in both sets; owner-only / counterparty-only actions live in one. `create_project`
// is intentionally absent: it needs no prior membership (see `can`).
const OWNER = new Set([
  ACTION.INVITE_COUNTERPARTY,
  ACTION.SET_OPERATING_MODEL,
  ACTION.VIEW_PROJECT,
  ACTION.RECORD_DECISION,
  ACTION.REVISE_DECISION,
  ACTION.PROPOSE_CHANGE_ORDER,
  ACTION.DECIDE_CHANGE_ORDER, // "owner may always decide" — still subject to ≠ proposer below
  ACTION.PROPOSE_PLAN,
  ACTION.REVIEW_PLAN,
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
  ACTION.IMPORT_PLAN,
  ACTION.UPLOAD_PLAN_DOCUMENT,
  ACTION.PROPOSE_PLAN,
  ACTION.REVIEW_PLAN,
  ACTION.RECORD_MOVEMENT,
]);

// Band B (ADR-0011) direct/hybrid builds invite a `subcontractor` who is on the
// record but whose authority is deliberately minimal in THIS slice: they see the
// build (identity actions) and nothing else. Any write capabilities a
// subcontractor earns (schedule, progress, …) are owned by the sibling service
// that defines them — add actions there, not here, and only after the Architect
// signs the capability row.
const SUBCONTRACTOR = new Set([
  ACTION.VIEW_PROJECT,
]);

const CAPABILITIES = {
  owner: OWNER,
  counterparty: COUNTERPARTY,
  subcontractor: SUBCONTRACTOR,
};

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
 * @param {string} [ctx.actorPartyId]  required for DECIDE_CHANGE_ORDER / REVIEW_PLAN
 * @param {string} [ctx.proposedByPartyId] the CO proposer (DECIDE_CHANGE_ORDER) or
 *                                     plan-proposal author (REVIEW_PLAN), for the two-sided rule
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

  // Slice B2 (LINA-200, contract §6): REVIEW_PLAN is the OTHER party's action — a
  // party may not review (accept/reject/request-changes) its own proposal. `can`
  // receives `proposedByPartyId` from the version row (resolved by the schedule
  // service, never the request) and denies the proposer, mirroring the change-order
  // two-sided rule. PROPOSE_PLAN/withdraw is the proposer's own action and is
  // authorised by the schedule service against proposed_by_party_id.
  if (action === ACTION.REVIEW_PLAN) {
    if (!proposedByPartyId) {
      return deny('proposer unknown — cannot evaluate the reviewer rule');
    }
    if (actorPartyId && actorPartyId === proposedByPartyId) {
      return deny('a party may not review its own plan proposal');
    }
  }

  return { allow: true };
}

function deny(reason) {
  return { allow: false, reason };
}
