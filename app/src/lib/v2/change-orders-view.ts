// Pure v2-wire → view transforms and the decide-eligibility logic for the
// change-order surface (LINA-321, S4 of the UI cutover, doc 22 §3). Split out of
// the I/O module (`./change-orders.ts`, which imports `server-only`) so the
// mapping and — above all — the *proposer-never-decides* gate are unit-testable
// without a Clerk session or a router, exactly as `profile-view.ts` is the pure
// counterpart to `profile.ts` on the S1 side.
//
// ── WHY THE MAPPING IS PARTIAL, AND HONESTLY SO ──────────────────────────────
// The v1 change order (`lib/types.ts` ChangeOrderDetail) is a PROJECT-scoped,
// narrative record: a free-typed `title`, an arbitrary `costDeltaCents`, a
// "raised by {name} ({role})" line, a budget "before → after", and free-text
// scope / schedule / quality notes. The v2 change order (openapi `ChangeOrder`,
// modules/contracting) is a CONTRACT-scoped, ledger record: it carries a `number`,
// a `kind` (scope|time|scope_and_time), a `reason`, BoQ `lines` and `time` ops,
// and a server-derived `amount_delta` — money is NEVER free-typed, it is the sum
// of the line operations (contracting/domain/money.mjs::lineAmountCents). The two
// bodies do not carry the same facts, so this module maps only what v2 states
// authoritatively and marks the rest ABSENT rather than inventing it:
//
//   • `title`   ← `reason` (v2 has no title; the reason is the human line).
//   • `amountDeltaCents` ← `amount_delta.amount_cents` (ledger-authoritative).
//   • budget before/after — ABSENT. v2 keeps the running total on the contract
//     financials (GET /contracts/{id}/financials), not on the CO body; a
//     before/after pair would be an invented number here.
//   • raised-by / decided-by NAME + build ROLE — ABSENT. The v2 `Actor` is
//     `{ org_id, person_id, org_role? }` with no display name and no v1 build
//     role; naming the party needs an identity/contracting read the CO body does
//     not include.
//
// What IS fully specified by the v2 body — and is the whole point of this slice —
// is the *decision gate*: who may decide, and the clean surfacing of the
// `two_sided_rule` (doc 06 §6.1). That lives here as `canDecide`/`decideBlock`
// and is exhaustively tested, so no proposer is ever shown a decide button on
// their own CO and a 403 from the handler reads as a sentence, not a status code.
import type { CoStatus } from '@/lib/types';
import type { V2Me } from './profile-view';

// ── The v2 wire shapes we read (subset of openapi `ChangeOrder`) ─────────────

/** The five-state lifecycle (contracting/domain/money.mjs CO_TRANSITIONS). */
export type V2CoStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn';

export type V2CoKind = 'scope' | 'time' | 'scope_and_time';

export interface V2Money {
  amount_cents: number;
  currency: string;
}

/** openapi `Actor` — no display name, no v1 build role. */
export interface V2Actor {
  org_id: string;
  person_id?: string;
  org_role?: string;
}

export interface V2ChangeOrder {
  id: string;
  contract_id: string;
  number: string;
  kind: V2CoKind;
  reason: string;
  amount_delta: V2Money;
  lines?: unknown[];
  time?: unknown[];
  linked_change_order_id?: string;
  from_variation_ids?: string[];
  proposed_by: V2Actor;
  decided_by?: V2Actor;
  decided_at?: string;
  status: V2CoStatus;
  version: number;
}

// ── The honest view the UI renders ───────────────────────────────────────────

/**
 * What the change-order surface can render from a v2 CO body alone. Fields with
 * no v2 source are simply not on this shape (see the header) — a caller that
 * needs budget before/after or a party name resolves them from the contract
 * financials / identity reads, never from a guess made here.
 */
export interface ChangeOrderV2View {
  id: string;
  contractId: string;
  number: string;
  kind: V2CoKind;
  /** v2 `reason` — the human line; v2 has no separate title. */
  title: string;
  /** Ledger-authoritative, summed from the line ops by the handler. */
  amountDeltaCents: number;
  currency: string;
  status: V2CoStatus;
  proposedByOrgId: string;
  decidedByOrgId?: string;
  decidedAt?: string;
  lineCount: number;
  timeCount: number;
}

export function centsOf(m: V2Money | null | undefined): number {
  return Number(m?.amount_cents ?? 0);
}

export function toChangeOrderView(co: V2ChangeOrder): ChangeOrderV2View {
  return {
    id: co.id,
    contractId: co.contract_id,
    number: co.number,
    kind: co.kind,
    title: co.reason,
    amountDeltaCents: centsOf(co.amount_delta),
    currency: co.amount_delta?.currency ?? 'EUR',
    status: co.status,
    proposedByOrgId: co.proposed_by.org_id,
    decidedByOrgId: co.decided_by?.org_id,
    decidedAt: co.decided_at,
    lineCount: (co.lines ?? []).length,
    timeCount: (co.time ?? []).length,
  };
}

/**
 * The legacy three-state chip (`CoStatusChip`, `CoStatus`) predates v2's
 * five-state lifecycle. Mapping is lossy and DOCUMENTED as such: draft and
 * submitted both read as "proposed" (pending review); withdrawn has no legacy
 * cell and reads as "rejected" (it is a not-approved terminal state). A wiring
 * slice that wants to distinguish draft/withdrawn should render v2 `status`
 * directly rather than round-trip through this.
 */
export function toLegacyChipStatus(status: V2CoStatus): CoStatus {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'rejected':
    case 'withdrawn':
      return 'rejected';
    default:
      return 'proposed';
  }
}

// ── The decision gate (the slice's core invariant) ───────────────────────────

/** Human copy for the handler's `two_sided_rule` (403) — a sentence, not a code. */
export const TWO_SIDED_MESSAGE =
  'You proposed this change, so the other party decides it — no organisation approves its own change order.';

/** True when the viewer's active org is the one that proposed this CO. */
export function isProposer(co: V2ChangeOrder, me: V2Me | null): boolean {
  const orgId = me?.active_org?.id ?? null;
  return orgId != null && orgId === co.proposed_by.org_id;
}

export type DecideBlock =
  | { canDecide: true }
  | { canDecide: false; reason: 'no_active_org' | 'proposer' | 'not_open'; message: string };

/**
 * The single source of truth for whether the viewer may see a decide button, and
 * why not when they cannot. It never returns `canDecide:true` for the proposing
 * org — that is the `two_sided_rule` enforced server-side and by a DB CHECK; the
 * UI must not offer an action the handler will 403. A CO is decidable ONLY while
 * `submitted` (draft is unsent; approved/rejected/withdrawn are terminal).
 */
export function decideBlock(co: V2ChangeOrder, me: V2Me | null): DecideBlock {
  if (!me?.active_org) {
    return {
      canDecide: false,
      reason: 'no_active_org',
      message: 'Select an organisation to act on this change order.',
    };
  }
  if (isProposer(co, me)) {
    return { canDecide: false, reason: 'proposer', message: TWO_SIDED_MESSAGE };
  }
  if (co.status !== 'submitted') {
    return {
      canDecide: false,
      reason: 'not_open',
      message: 'This change order is not awaiting a decision.',
    };
  }
  return { canDecide: true };
}

/** Convenience boolean for the common case (button visibility). */
export function canDecide(co: V2ChangeOrder, me: V2Me | null): boolean {
  return decideBlock(co, me).canDecide;
}

/** The proposer may withdraw only while the CO is still open (draft or submitted). */
export function canWithdraw(co: V2ChangeOrder, me: V2Me | null): boolean {
  return isProposer(co, me) && (co.status === 'draft' || co.status === 'submitted');
}

/** The proposer submits a draft for the other party to decide. */
export function canSubmit(co: V2ChangeOrder, me: V2Me | null): boolean {
  return isProposer(co, me) && co.status === 'draft';
}
