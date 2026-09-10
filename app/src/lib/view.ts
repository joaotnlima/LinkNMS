// The view layer: pure functions from the API's wire shapes to the UI contract
// types in ./types.ts (LINA-57).
//
// WHY THIS FILE EXISTS. The four R0 surfaces were built against a hand-written
// fixture whose shapes were the *ideal* the design doc describes — a project
// that already carries its pillars, counts and member names. The services that
// actually shipped are correctly split along schema boundaries, so no single
// endpoint returns that: pillars come from the Ledger (`/projects/:id/status`),
// counts from Decision + Change Order, and party names exist only inside the
// Identity schema. Composing those into one screen-shaped object is a real job,
// and it belongs HERE — pure, synchronous, unit-tested — rather than smeared
// across `api.ts`'s I/O or, worse, across the page components.
//
// TWO RULES THIS FILE ENFORCES, both from FR5/FR9 and both easy to get wrong:
//
//  1. NOTHING HERE COMPUTES BUDGET OR STATUS. Every number and every pillar
//     label/colour/icon is passed through from the ledger-derived payload. A
//     frontend that re-derives "how much did this move the budget" is a second
//     source of truth for the one number the whole product is a lookup for.
//
//  2. NO INVENTED ATTRIBUTION. An unresolvable party id renders as
//     "Unknown party", never as a plausible-looking name and never silently
//     omitted. On a record whose promise is "who decided this", a confident
//     wrong name is worse than an honest gap.
import type {
  Project, Pillars, Decision, Revision, ChangeOrderSummary, ChangeOrderDetail,
  AuditResult, AuditEvent, Role, Party, BuildStatus, OperatingModel,
} from './types';

// ── Wire shapes (what the services actually return) ──────────────────────────
// Written out rather than imported: these mirror services/*/http.mjs, and a
// deliberate local restatement is what makes a contract drift show up as a type
// error in the mappers below instead of as `undefined` on a screen.

export interface WireMember { partyId: string; role: string; joinedAt: string; displayName?: string | null }
export interface WireProject {
  id: string;
  name: string;
  // NULL for a GC-created build until the invited homeowner accepts (ADR-0016
  // §1). Authorization never reads this field — it decides on membership role —
  // so a null owner is a build with no homeowner member yet, not an authz hole.
  ownerPartyId: string | null;
  baselineBudgetCents: number;
  currentBudgetCents: number;
  actingRole: Role;
  createdAt: string;
  // Band B, added by migration 0009 / ADR-0011 and returned by shapeProject().
  // Optional here rather than required: this interface is also the shape the
  // pre-0009 fixtures and any deployed-but-not-yet-migrated API return, and a
  // required field would turn a rolling deploy into a type lie.
  status?: BuildStatus;
  operatingModel?: OperatingModel | null;
  // Basics descriptive fields (LINA-219, migration 0014). Optional and nullable
  // for the same reason as status/operatingModel above: legacy rows, drafts that
  // skipped them, and any pre-0014 API all legitimately return none.
  siteAddress?: string | null;
  buildType?: string | null;
  expectedStart?: string | null;
  members: WireMember[];
}

export interface WireRevision {
  rev: number; title: string; body: string; authorPartyId: string | null; at: string;
}
export interface WireDecision {
  id: string; projectId: string; createdByPartyId: string | null; createdAt: string;
  currentRev: number; edited: boolean; title: string; body: string;
  revisions: WireRevision[];
}

export interface WireChangeOrder {
  id: string; projectId: string; decisionId?: string | null; title: string;
  costDeltaCents: number; status: 'proposed' | 'approved' | 'rejected';
  proposedBy: string | null; decidedBy?: string | null;
  createdAt: string; decidedAt?: string | null;
  scopeImpactNote?: string | null;
  scheduleImpactDays?: number | null;
  scheduleImpactNote?: string | null;
  qualityFlag?: boolean;
  qualityNote?: string | null;
  budget: {
    baselineCents: number; currentCents: number;
    beforeCents: number; afterCents: number; movedCents: number;
    projectedIfApprovedCents: number | null;
  };
}

export interface WireAuditEvent {
  seq: number; type: string; actorPartyId: string | null; occurredAt: string;
  payload: Record<string, unknown> | null; entryHash: string;
}
export interface WireAudit { events: WireAuditEvent[]; verified: true | number; headHash: string }

/**
 * partyId → { name, role } for everyone on the project. Built once per request
 * from the project payload and threaded into every other mapper, because it is
 * the ONLY place party names are available: decision and change_order live in
 * their own schemas and legitimately know nothing but ids.
 */
export type Directory = Map<string, { name: string; role: Role }>;

export const UNKNOWN_PARTY = 'Unknown party';

// R0 has exactly two seats on a record. Identity's party table also carries
// 'contractor'/'viewer' as a *party* role, which is a different axis from the
// per-project membership role; anything that is not the owner is the
// counterparty as far as these surfaces are concerned.
// `subcontractor` is a real membership role since migration 0009 (ADR-0011 §4),
// so it is mapped rather than folded into `counterparty`. Folding it would
// attribute a specialty sub's entry to "the GC" on the audit trail — an invented
// attribution, which rule 2 at the top of this file forbids. Anything else still
// falls back to `counterparty`: an unknown role is a contract drift, and the
// conservative read is "the other party", not "the owner".
const asRole = (role: string | null | undefined): Role =>
  role === 'owner' ? 'owner' : role === 'subcontractor' ? 'subcontractor' : 'counterparty';

export function directoryOf(project: WireProject): Directory {
  const dir: Directory = new Map();
  for (const m of project.members) {
    dir.set(m.partyId, { name: m.displayName?.trim() || UNKNOWN_PARTY, role: asRole(m.role) });
  }
  return dir;
}

const nameOf = (dir: Directory, partyId: string | null | undefined): string =>
  (partyId && dir.get(partyId)?.name) || UNKNOWN_PARTY;

const roleOf = (dir: Directory, partyId: string | null | undefined): Role =>
  (partyId && dir.get(partyId)?.role) || 'counterparty';

// ── Project ──────────────────────────────────────────────────────────────────

export interface Counts {
  decisions: number;
  changeOrders: { total: number; proposed: number; approved: number; rejected: number };
}

/** Counts are a fold over the lists the surfaces already fetch — never a
 *  separate count endpoint that could disagree with the list beside it. */
export function countsOf(decisions: WireDecision[], changeOrders: WireChangeOrder[]): Counts {
  const tally = { total: changeOrders.length, proposed: 0, approved: 0, rejected: 0 };
  for (const co of changeOrders) tally[co.status] += 1;
  return { decisions: decisions.length, changeOrders: tally };
}

export function toParty(m: WireMember): Party {
  return { id: m.partyId, name: m.displayName?.trim() || UNKNOWN_PARTY, role: asRole(m.role) };
}

/**
 * The dashboard's screen-shaped object. `pillars` arrives already derived by the
 * ledger (services/ledger/status.mjs) and is passed through untouched — see
 * rule 1 at the top of this file.
 */
export function toProject(wire: WireProject, pillars: Pillars, counts: Counts): Project {
  return {
    id: wire.id,
    name: wire.name,
    baselineBudgetCents: wire.baselineBudgetCents,
    currentBudgetCents: wire.currentBudgetCents,
    actingRole: wire.actingRole,
    // Passed through, never inferred. "Is this build still a draft?" is the
    // question the wizard resumes on, and guessing it from (say) "has no
    // counterparty" would show the invite step for a build the owner already
    // committed with a copy-link.
    status: wire.status,
    operatingModel: wire.operatingModel ?? null,
    members: wire.members.map(toParty),
    pillars,
    counts,
  };
}

// ── Decisions ────────────────────────────────────────────────────────────────

function toRevision(r: WireRevision, dir: Directory): Revision {
  return {
    rev: r.rev,
    title: r.title,
    body: r.body,
    authorName: nameOf(dir, r.authorPartyId),
    authorRole: roleOf(dir, r.authorPartyId),
    createdAt: r.at,
  };
}

export function toDecision(wire: WireDecision, dir: Directory): Decision {
  // Ascending by revision so `revisions[0]` is rev 1 (the original) and the UI's
  // `length > 1 ⇒ edited` test holds. The service already orders them, but the
  // "edited" affordance is an integrity claim, so it does not rely on that.
  const revisions = [...wire.revisions].sort((a, b) => a.rev - b.rev);
  return {
    id: wire.id,
    title: wire.title,
    body: wire.body,
    authorName: nameOf(dir, wire.createdByPartyId),
    authorRole: roleOf(dir, wire.createdByPartyId),
    createdAt: wire.createdAt,
    revisions: revisions.map((r) => toRevision(r, dir)),
  };
}

// ── Change orders ────────────────────────────────────────────────────────────

export function toChangeOrderSummary(wire: WireChangeOrder, dir: Directory): ChangeOrderSummary {
  return {
    id: wire.id,
    title: wire.title,
    status: wire.status,
    costDeltaCents: wire.costDeltaCents,
    proposedByName: nameOf(dir, wire.proposedBy),
    proposedByRole: roleOf(dir, wire.proposedBy),
    createdAt: wire.createdAt,
    ...(wire.decidedBy ? { decidedByName: nameOf(dir, wire.decidedBy) } : {}),
    ...(wire.decidedAt ? { decidedAt: wire.decidedAt } : {}),
    ...(wire.scheduleImpactDays != null ? { scheduleImpactDays: wire.scheduleImpactDays } : {}),
    ...(wire.qualityFlag ? { qualityFlag: true } : {}),
  };
}

/**
 * The one-screen answer to "who decided this, when, and how much did it move the
 * budget" (FR6).
 *
 * FR5 lives in the `before`/`after` pair. The service already distinguishes the
 * two cases and this mapper must not blur them: for an APPROVED order,
 * before→after is the move that really happened; for a proposed or rejected one,
 * `budget.beforeCents === budget.afterCents` because nothing moved, and the
 * hypothetical is carried separately in `projectedIfApprovedCents`. Passing the
 * projection through as `budgetAfterCents` would make a proposal look like it
 * had already been applied — the exact failure FR5 exists to prevent.
 */
export function toChangeOrderDetail(wire: WireChangeOrder, dir: Directory): ChangeOrderDetail {
  return {
    ...toChangeOrderSummary(wire, dir),
    ...(wire.decisionId ? { decisionId: wire.decisionId } : {}),
    ...(wire.decidedBy ? { decidedByRole: roleOf(dir, wire.decidedBy) } : {}),
    ...(wire.status === 'approved' ? { decision: 'approve' as const } : {}),
    ...(wire.status === 'rejected' ? { decision: 'reject' as const } : {}),
    budgetBeforeCents: wire.budget.beforeCents,
    budgetAfterCents: wire.budget.afterCents,
    ...(wire.scopeImpactNote ? { scopeImpactNote: wire.scopeImpactNote } : {}),
    ...(wire.scheduleImpactNote ? { scheduleImpactNote: wire.scheduleImpactNote } : {}),
    ...(wire.qualityNote ? { qualityNote: wire.qualityNote } : {}),
  };
}

/** What the total *would* become if a proposed order were approved. Null for
 *  anything already decided — see FR5 above. */
export function projectedIfApproved(wire: WireChangeOrder): number | null {
  return wire.status === 'proposed' ? wire.budget.projectedIfApprovedCents : null;
}

// ── Audit trail ──────────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * A one-line human summary per chain event.
 *
 * Presentation only — the hash chain is the record, this is the sentence above
 * it. An event type this build has never seen still renders (as its raw type)
 * rather than vanishing: an audit trail that silently drops rows it does not
 * recognise is not an audit trail.
 */
export function summarize(e: WireAuditEvent): string {
  const p = e.payload ?? {};
  const title = str(p.title);
  switch (e.type) {
    case 'project_created':
      return `Project “${str(p.name) ?? 'untitled'}” created`;
    case 'budget_baseline_set':
      return 'Baseline budget set';
    case 'member_joined':
      return `${str(p.role) === 'owner' ? 'Owner' : 'Counterparty'} joined the record`;
    case 'invitation_sent':
      return 'Counterparty invited';
    case 'decision_recorded':
      return `Decision recorded${title ? `: “${title}”` : ''}`;
    case 'decision_revised':
      return `Decision revised${title ? `: “${title}”` : ''}${num(p.rev) ? ` (rev ${num(p.rev)})` : ''}`;
    case 'change_order_proposed':
      return `Change proposed${title ? `: “${title}”` : ''}`;
    case 'change_order_approved':
      return `Change approved${title ? `: “${title}”` : ''}`;
    case 'change_order_rejected':
      return `Change rejected${title ? `: “${title}”` : ''}`;
    case 'budget_moved':
      return 'Budget moved';
    // Plan authoring → proposal (LINA-228/LINA-230). A draft is saved privately
    // (plan_drafted, possibly more than once) and later sent for approval
    // (plan_proposed) — the two read as distinct lines so the trail shows exactly
    // when the work was saved and when it was sent (acceptance §4).
    case 'plan_drafted':
      return 'Plan draft saved';
    case 'plan_proposed':
      return `Plan sent for approval${num(p.versionNo) ? ` (version ${num(p.versionNo)})` : ''}`;
    default:
      return e.type;
  }
}

/**
 * The budget delta to show against an event, or undefined when the event moved
 * nothing.
 *
 * ONLY `budget_moved` carries a delta. A `change_order_proposed` payload also
 * contains a `costDeltaCents`, and surfacing that here is the single most
 * tempting way to break FR5: the audit trail would show a proposed — or
 * rejected — change appearing to move the budget. It moved nothing until the
 * ledger says it did, and the ledger says so by emitting `budget_moved`.
 */
export function budgetDeltaOf(e: WireAuditEvent): number | undefined {
  if (e.type !== 'budget_moved') return undefined;
  return num(e.payload?.deltaCents);
}

export function toAuditEvent(e: WireAuditEvent, dir: Directory): AuditEvent {
  const deltaCents = budgetDeltaOf(e);
  return {
    seq: e.seq,
    type: e.type as AuditEvent['type'],
    summary: summarize(e),
    actorName: nameOf(dir, e.actorPartyId),
    actorRole: roleOf(dir, e.actorPartyId),
    createdAt: e.occurredAt,
    ...(deltaCents === undefined ? {} : { budgetDeltaCents: deltaCents }),
    entryHash: e.entryHash,
  };
}

export function toAuditResult(wire: WireAudit, dir: Directory): AuditResult {
  return {
    events: wire.events.map((e) => toAuditEvent(e, dir)),
    verified: wire.verified,
    headHash: wire.headHash,
  };
}
