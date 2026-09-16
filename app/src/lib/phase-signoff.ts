// Execution-phase sign-off — the pure rules behind the UI (LINA-282, ADR-0023
// §6 and §8).
//
// ── WHY A PURE MODULE ────────────────────────────────────────────────────────
// Sign-off is the moment the plan stops being editable and starts being a
// commitment. Which affordance the screen offers — "Request sign-off", "waiting
// on them", "approve or ask for changes", "locked, raise a change order" —
// depends on three facts that arrive from three different places (the phase
// row, the open sign-off request, and who is looking). Deriving that in JSX is
// how a build ships an Approve button to the person who asked for the sign-off.
// So the derivation lives here, is total over its inputs, and is unit-tested.
//
// ── THE SERVER IS THE AUTHORITY ──────────────────────────────────────────────
// Everything below shapes buttons. The 409 PLAN_LOCKED guard in
// services/schedule (ADR-0023 §8) is what actually stops a write, and the
// requester ≠ approver rule is enforced by the API. A bug here is a confusing
// screen, never an unauthorised mutation.

/** `schedule.project_phase.status` (ADR-0023 §2). */
export type PhaseStatus = 'pending' | 'active' | 'signed_off' | 'archived';

/** `schedule.phase_sign_off_request.status` (ADR-0023 §2). */
export type SignOffStatus = 'pending' | 'approved' | 'rejected';

export interface SignOffRequest {
  id: string;
  /** identity.party.id of whoever asked for the sign-off. */
  requestedBy: string;
  requestedAt: string;
  status: SignOffStatus;
  resolvedAt?: string | null;
  /** Free text the approver left when rejecting — shown verbatim to the requester. */
  resolutionComment?: string | null;
  /** Resolved display names, when the API joins them. Never invented here. */
  requestedByName?: string | null;
  resolvedByName?: string | null;
}

export interface ExecutionPhase {
  id: string;
  status: PhaseStatus;
  /**
   * Sign-off requests newest-first, INCLUDING resolved ones — rows are
   * append-only (ADR-0023 §2), so the history is the audit story and a
   * rejection is never overwritten by the retry that followed it.
   */
  signOffRequests: SignOffRequest[];
}

export interface SignOffViewerContext {
  /** The acting party, read from the verified session server-side. */
  partyId: string | null;
  /**
   * Whether this viewer is the one the sign-off is addressed to. Derived
   * server-side from the phase's responsible parties — never inferred here from
   * a role string, because "who signs off" is a project fact, not a job title.
   */
  canDecide: boolean;
  /** Whether this viewer may ask for sign-off at all (the plan's driver). */
  canRequest: boolean;
}

/**
 * The one live request, or null. Append-only history means "pending" is the
 * only status that can be open, and §2's partial unique index guarantees at
 * most one of them.
 */
export function openRequest(phase: ExecutionPhase | null | undefined): SignOffRequest | null {
  return phase?.signOffRequests?.find((r) => r.status === 'pending') ?? null;
}

/**
 * The most recent rejection that is still the last word — i.e. no newer request
 * has been opened since. That is the only rejection worth surfacing inline: an
 * older one is history, and history lives in the expanded section.
 */
export function standingRejection(phase: ExecutionPhase | null | undefined): SignOffRequest | null {
  const rs = phase?.signOffRequests ?? [];
  if (rs.length === 0) return null;
  const latest = [...rs].sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))[0];
  return latest.status === 'rejected' ? latest : null;
}

/** The approved request that locked the plan, if it is locked. */
export function approvedRequest(phase: ExecutionPhase | null | undefined): SignOffRequest | null {
  const rs = phase?.signOffRequests ?? [];
  return [...rs]
    .filter((r) => r.status === 'approved')
    .sort((a, b) => ((a.resolvedAt ?? '') < (b.resolvedAt ?? '') ? 1 : -1))[0] ?? null;
}

/**
 * Is the plan grid read-only?
 *
 * Both `signed_off` AND a pending request lock it. Locking while the request is
 * merely pending is deliberate and is the stricter reading of the issue: the
 * approver is being asked to sign off on the plan AS SENT, and a plan that can
 * still move underneath them makes the signature meaningless. `archived` locks
 * too — a closed phase is a record, not a workspace.
 */
export function isPlanLocked(phase: ExecutionPhase | null | undefined): boolean {
  if (!phase) return false;
  if (phase.status === 'signed_off' || phase.status === 'archived') return true;
  return openRequest(phase) !== null;
}

/** What the accordion header badge says. `awaiting_sign_off` is a UI state, not a DB one. */
export type PhaseBadge = 'draft' | 'active' | 'awaiting_sign_off' | 'signed_off' | 'archived';

export function phaseBadge(phase: ExecutionPhase | null | undefined): PhaseBadge {
  if (!phase) return 'draft';
  if (phase.status === 'signed_off') return 'signed_off';
  if (phase.status === 'archived') return 'archived';
  if (openRequest(phase)) return 'awaiting_sign_off';
  if (phase.status === 'active') return 'active';
  return 'draft';
}

export const BADGE_LABEL: Record<PhaseBadge, string> = {
  draft: 'Draft',
  active: 'Active',
  awaiting_sign_off: 'Awaiting sign-off',
  signed_off: 'Signed off',
  archived: 'Archived',
};

/** Why the "Request sign-off" button is unavailable, or null when it is usable. */
export type RequestBlockReason = 'no-tasks' | 'not-active' | 'already-pending' | 'already-signed-off' | 'not-permitted';

export const REQUEST_BLOCK_COPY: Record<RequestBlockReason, string> = {
  'no-tasks': 'Add at least one task to the plan before asking for sign-off.',
  'not-active': 'The execution phase is not active yet.',
  'already-pending': 'A sign-off request is already awaiting a decision.',
  'already-signed-off': 'This plan is already signed off.',
  'not-permitted': 'Only the party driving the plan can request sign-off.',
};

/**
 * The Execution section's controls, fully derived. Ordering matters: the
 * permission and lifecycle answers come BEFORE "you have no tasks", so a viewer
 * who could never press the button is not told to go add tasks first.
 */
export interface SignOffControls {
  /** Render the request button at all (it is the driver's control, not the approver's). */
  showRequestButton: boolean;
  requestDisabled: boolean;
  /** Tooltip + aria-description for the disabled button. Null when enabled. */
  requestBlockedReason: RequestBlockReason | null;
  requestBlockedCopy: string | null;
  /** Render Approve / Request changes (the approver's side of an open request). */
  showDecisionControls: boolean;
  /** The request those controls act on. */
  pendingRequest: SignOffRequest | null;
  /** "Sent for sign-off" banner — shown to the requester while they wait. */
  showAwaitingBanner: boolean;
  /** The rejection the requester still has to answer, if any. */
  rejection: SignOffRequest | null;
  /** The approval that locked the plan, if it is locked. */
  approval: SignOffRequest | null;
  locked: boolean;
  badge: PhaseBadge;
}

export function signOffControls(
  phase: ExecutionPhase | null | undefined,
  viewer: SignOffViewerContext,
  taskCount: number,
): SignOffControls {
  const pending = openRequest(phase);
  const locked = isPlanLocked(phase);
  const signedOff = phase?.status === 'signed_off';

  let reason: RequestBlockReason | null = null;
  if (!viewer.canRequest) reason = 'not-permitted';
  else if (signedOff) reason = 'already-signed-off';
  else if (pending) reason = 'already-pending';
  else if (phase?.status !== 'active') reason = 'not-active';
  else if (taskCount <= 0) reason = 'no-tasks';

  // The button stays VISIBLE and disabled when the only thing missing is tasks:
  // that is a to-do the author can act on, and hiding it would read as "this
  // build has no sign-off step". Every other block hides it — an approver has no
  // use for a greyed control explaining someone else's permissions.
  const showRequestButton =
    viewer.canRequest && !signedOff && !pending && (reason === null || reason === 'no-tasks' || reason === 'not-active');

  return {
    showRequestButton,
    requestDisabled: reason !== null,
    requestBlockedReason: reason,
    requestBlockedCopy: reason ? REQUEST_BLOCK_COPY[reason] : null,
    showDecisionControls: pending !== null && viewer.canDecide,
    pendingRequest: pending,
    showAwaitingBanner: pending !== null && !viewer.canDecide,
    rejection: standingRejection(phase),
    approval: signedOff ? approvedRequest(phase) : null,
    locked,
    badge: phaseBadge(phase),
  };
}

/** Number of leaf + task rows a plan carries — the "is there anything to sign off" test. */
export function countPlanTasks(
  phases: Array<{ tasks?: Array<{ children?: unknown[] }> }> | null | undefined,
): number {
  let n = 0;
  for (const p of phases ?? []) {
    for (const t of p.tasks ?? []) {
      n += 1;
      n += (t.children ?? []).length;
    }
  }
  return n;
}

/**
 * The set of plan-row keys that have a change order in flight (ADR-0023 §6,
 * clay/amber). Built from the open change orders the server already joins to
 * the plan, so the grid never has to know what a change order is.
 */
export function pendingChangeKeys(
  openChangeOrders: Array<{ targetKey?: string | null }> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const co of openChangeOrders ?? []) {
    if (co.targetKey) out.add(co.targetKey);
  }
  return out;
}

/** "12 March 2026" — the sign-off stamp, in the record's own voice. */
export function signOffStamp(request: SignOffRequest | null): string | null {
  if (!request?.resolvedAt) return null;
  const d = new Date(request.resolvedAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
