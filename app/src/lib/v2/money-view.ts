// Pure v2-wire → view transforms for the Money surface (LINA-381, Phase 12b.2 of
// the v1 deprecation, doc 22 §3.3). Split out of the I/O module (`./money.ts`,
// which imports `server-only`) so the mapping and — above all — the money
// AGGREGATION are unit-testable without a Clerk session or a router, exactly as
// `change-orders-view.ts` is the pure counterpart to `change-orders.ts`.
//
// ── WHAT MONEY IS ON v2, AND WHY THIS REPLACES v1 `MoneyView` ─────────────────
// The v1 budget surface (`getBudgetMovement` + `MoneyMovement.tsx`) split money
// into `scope_change` vs `price_movement` rows against a Slice-B3 materials model.
// That model is RETIRED (doc 22 §3.3, LINA-362): on v2 the Money surface is the
// contracting/planning financial model, read from three registers, each already
// per-viewer-redacted server-side (money never crosses a visibility line here):
//
//   • Summary  — Σ `GET /contracts/{id}/financials` across the contracts the
//                viewer may see in full (`Financials`: value, approved changes,
//                measured, retention held, paid, outstanding). A fresh B2 project
//                has no signed contract, so the only honest figure is the owner's
//                `indicative_budget` (shown as a soft target, never as "value").
//   • Moves    — approved `contracting.change_order` rows via the project roll-up
//                (`GET /projects/{id}/change-orders`). One approved CO = one budget
//                move: `amount_delta`, `kind`, `reason`, `decided_by`, `decided_at`.
//   • Drift    — open/acknowledged `planning.variation` via
//                `GET /projects/{id}/variations`. The "pending money" that has
//                deviated from baseline but has NO change order yet — the
//                early-warning half of the product promise.
//
// Guiding principle (doc 22 §3.1/§3.2/§3.3): RESOLVE, NEVER INVENT. A number is
// shown only when a v2 read states it authoritatively; a party is named only from
// what the viewer already holds (`resolveOrgLabel`), never a guess or a raw UUID.
import {
  centsOf,
  resolveOrgLabel,
  isExistenceOnly,
  type V2Money,
  type V2CoKind,
  type V2ChangeOrder,
  type V2ChangeOrderRow,
} from './change-orders-view.ts';
import type { V2Me } from './profile-view';

// ── The v2 wire shapes we read (subsets of the openapi bodies) ───────────────

/** `GET /api/v2/projects/{id}` — the fields Money needs (openapi `Project`). */
export interface V2ProjectMoney {
  id: string;
  name: string;
  status: string;
  /** The owner's target; the only honest figure on a pre-contract build. */
  indicative_budget?: V2Money;
}

/** `GET /api/v2/contracts/{id}/financials` — every field is Money (openapi `Financials`). */
export interface V2Financials {
  value: V2Money;
  approved_changes: V2Money;
  measured: V2Money;
  retention_held: V2Money;
  paid: V2Money;
  outstanding: V2Money;
}

/** A row of `GET /api/v2/projects/{id}/contracts` — the subset Money reads. A
 *  `scope`-visibility row carries no `value` and its financials are 403 to us. */
export interface V2ContractRow {
  id: string;
  reference: string;
  status: string;
  _visibility: 'full' | 'scope';
  value?: V2Money;
}

export type V2VariationKind = 'time' | 'cost' | 'material' | 'scope';
export type V2VariationStatus = 'open' | 'acknowledged' | 'formalised' | 'closed';

/** A row of `GET /api/v2/projects/{id}/variations` (subset of `variationBody`). */
export interface V2Variation {
  id: string;
  task_id: string;
  task_name?: string;
  kind: V2VariationKind;
  cause?: string;
  status: V2VariationStatus;
  last_changed_at?: string;
  /** Present once the variation has been formalised into a change order. */
  change_order_id?: string;
}

// ── The honest view the Money surface renders ────────────────────────────────

/** The summary register: Σ financials across the contracts the viewer sees in
 *  full. `contractCount === 0` is the B2 pre-contract state — the caller shows
 *  `indicativeBudgetCents` instead of asserting a zero "value". */
export interface MoneySummaryV2 {
  valueCents: number;
  approvedChangesCents: number;
  measuredCents: number;
  retentionHeldCents: number;
  paidCents: number;
  outstandingCents: number;
  /** How many full-visibility contracts fed the summary. */
  contractCount: number;
  currency: string;
}

/** One approved change order, projected as a budget move for the ledger. */
export interface MoneyMoveV2 {
  id: string;
  contractId: string;
  number?: string;
  kind: V2CoKind;
  /** v2 `reason` — the human line; v2 has no separate title. */
  title: string;
  amountDeltaCents: number;
  currency: string;
  /** Resolved from what the viewer holds; "The other party" otherwise. */
  decidedByLabel: string;
  decidedAt?: string;
}

/** One open/acknowledged variation, projected as a drift row. */
export interface MoneyDriftV2 {
  id: string;
  taskId: string;
  taskName: string;
  kind: V2VariationKind;
  status: V2VariationStatus;
  cause?: string;
  lastChangedAt?: string;
  /** Set once formalised — the drift became a change order. */
  changeOrderId?: string;
}

/** The whole Money surface, resolved for one viewer. */
export interface MoneyViewV2 {
  /** No active org → a neutral "pick an org" state, not "the build has none". */
  noActiveOrg: boolean;
  /** The owner's target budget, if set — the pre-contract anchor figure. */
  indicativeBudgetCents: number | null;
  summary: MoneySummaryV2;
  moves: MoneyMoveV2[];
  drift: MoneyDriftV2[];
}

// ── Transforms ───────────────────────────────────────────────────────────────

const ZERO_SUMMARY: MoneySummaryV2 = {
  valueCents: 0,
  approvedChangesCents: 0,
  measuredCents: 0,
  retentionHeldCents: 0,
  paidCents: 0,
  outstandingCents: 0,
  contractCount: 0,
  currency: 'EUR',
};

/**
 * Σ the per-contract financials into the one project-level summary. Each read is
 * already redacted to a contract the viewer may see in full, so summing them
 * re-implements no visibility — it only adds numbers the server already released.
 * An empty list is the honest B2 zero-summary (the caller shows the indicative
 * budget instead of these zeros).
 */
export function aggregateFinancials(list: V2Financials[]): MoneySummaryV2 {
  if (list.length === 0) return { ...ZERO_SUMMARY };
  const sum = list.reduce(
    (acc, f) => ({
      valueCents: acc.valueCents + centsOf(f.value),
      approvedChangesCents: acc.approvedChangesCents + centsOf(f.approved_changes),
      measuredCents: acc.measuredCents + centsOf(f.measured),
      retentionHeldCents: acc.retentionHeldCents + centsOf(f.retention_held),
      paidCents: acc.paidCents + centsOf(f.paid),
      outstandingCents: acc.outstandingCents + centsOf(f.outstanding),
    }),
    { valueCents: 0, approvedChangesCents: 0, measuredCents: 0, retentionHeldCents: 0, paidCents: 0, outstandingCents: 0 },
  );
  // Currency is EUR across the model today (money.mjs); take the first stated one
  // rather than assuming, but never mix — a mixed-currency project is out of scope.
  const currency = list.find((f) => f.value?.currency)?.value.currency ?? 'EUR';
  return { ...sum, contractCount: list.length, currency };
}

/** True when a change-order roll-up row is an approved, full-body budget move. An
 *  existence-only row (linked-chain, commercial body withheld) is NOT a move we
 *  can price, and a draft/submitted/rejected/withdrawn CO has not moved the
 *  budget — only `approved` does (ADR-0014, carried into v2). */
export function isApprovedMove(row: V2ChangeOrderRow): row is V2ChangeOrder {
  if (isExistenceOnly(row)) return false;
  return (row as V2ChangeOrder).status === 'approved';
}

/** Project one approved change order (full wire body) as a budget move. */
export function toMoveRow(co: V2ChangeOrder, me: V2Me | null): MoneyMoveV2 {
  return {
    id: co.id,
    contractId: co.contract_id,
    number: co.number,
    kind: co.kind,
    title: co.reason,
    amountDeltaCents: centsOf(co.amount_delta),
    currency: co.amount_delta?.currency ?? 'EUR',
    decidedByLabel: resolveOrgLabel(co.decided_by?.org_id, me),
    decidedAt: co.decided_at,
  };
}

/**
 * The moves ledger: every approved CO in the roll-up, newest decision first.
 * Rows the viewer sees only by existence are skipped — their money is withheld,
 * so they are not part of "what moved the budget I can see".
 */
export function toMoves(rows: V2ChangeOrderRow[], me: V2Me | null): MoneyMoveV2[] {
  return rows
    .filter(isApprovedMove)
    .map((co) => toMoveRow(co, me))
    .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
}

const OPEN_DRIFT: ReadonlySet<V2VariationStatus> = new Set(['open', 'acknowledged']);

/** Project one variation as a drift row (an unnamed task falls back to its id
 *  short form so a row never reads as blank). */
export function toDriftRow(v: V2Variation): MoneyDriftV2 {
  return {
    id: v.id,
    taskId: v.task_id,
    taskName: v.task_name || 'Untitled line',
    kind: v.kind,
    status: v.status,
    cause: v.cause,
    lastChangedAt: v.last_changed_at,
    changeOrderId: v.change_order_id,
  };
}

/**
 * The drift list: variations that have deviated but are NOT yet formalised into
 * a change order — the early-warning register. `formalised`/`closed` variations
 * are excluded: a formalised one is already counted as an approved move above,
 * and a closed one is back to baseline. Newest change first.
 */
export function toDrift(rows: V2Variation[]): MoneyDriftV2[] {
  return rows
    .filter((v) => OPEN_DRIFT.has(v.status))
    .map(toDriftRow)
    .sort((a, b) => (b.lastChangedAt ?? '').localeCompare(a.lastChangedAt ?? ''));
}

/** Assemble the whole Money view from the reads the surface gathered. */
export function buildMoneyView(input: {
  noActiveOrg: boolean;
  indicativeBudgetCents: number | null;
  financials: V2Financials[];
  changeOrders: V2ChangeOrderRow[];
  variations: V2Variation[];
  me: V2Me | null;
}): MoneyViewV2 {
  return {
    noActiveOrg: input.noActiveOrg,
    indicativeBudgetCents: input.indicativeBudgetCents,
    summary: aggregateFinancials(input.financials),
    moves: toMoves(input.changeOrders, input.me),
    drift: toDrift(input.variations),
  };
}

/** Human label for a variation kind (colour is never the only signal, FR9). */
export function driftKindLabel(kind: V2VariationKind): string {
  switch (kind) {
    case 'time':
      return 'Schedule';
    case 'cost':
      return 'Cost';
    case 'material':
      return 'Material';
    case 'scope':
      return 'Scope';
  }
}

/** Human label for a change-order kind. */
export function moveKindLabel(kind: V2CoKind): string {
  switch (kind) {
    case 'scope':
      return 'Scope';
    case 'time':
      return 'Time';
    case 'scope_and_time':
      return 'Scope & time';
  }
}
