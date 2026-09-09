// The Slice B3 client contract — D14 (the record, live), D15 (line detail —
// materials behind the price), D16 (budget — materials & price movement).
// Frozen contract: docs/architecture/slice-b3-live-record-materials-contract.md
// §3 (API) + §5 (FE). Decision: ADR-0014.
//
// WHAT LIVES HERE AND WHY
// The wire shapes, the two writes, and the handful of pure functions the three
// screens make decisions with — the same split as lib/plan-baseline.ts, so the
// parts that can be wrong in an expensive way run under `node --test` without a
// browser (record.test.mjs), and the screens stay copy and layout.
//
// THE RULES THIS FILE KEEPS (contract §0/§3/§5):
//
//  1. THE TWO MOVEMENT KINDS NEVER BLUR. `scope_change` carries a change order
//     and no price cause; `price_movement` carries a price cause and no change
//     order. The DB CHECK enforces it (ADR-0014 §3) and `validateSwap` below
//     refuses the same shapes BEFORE the round trip, so the screen states the
//     rule in the form rather than discovering it in a 400.
//
//  2. NO CLIENT-SIDE MONEY CLAIM IS AUTHORITATIVE. `swapPreview` mirrors the
//     server's newExtended − priorExtended so the person recording a movement
//     sees what they are about to move; the number that lands on the record is
//     the one the SERVER computes (§3b) and re-reads afterwards. The preview is
//     labelled as a preview on the screen for exactly that reason.
//
//  3. A PRICE MOVEMENT IS NEVER SUMMED INTO THE CONTRACT TOTAL. There is no
//     function here that adds `priceMovements` to `currentBudgetCents`, and
//     `moneyTotals` returns the two sums SEPARATELY and names them. That is the
//     whole load-bearing distinction of D16 (§3c).
//
//  4. NOTHING HERE DECIDES WHO MAY ACT. `canAuthorMaterials` / `canRecordMovement`
//     shape the affordances; the server authorises every call from the session
//     (§4) and a refusal renders as the typed refusal it is.
import type { PlanBaselineView } from './plan-baseline';

// ── Wire shapes (contract §3) ────────────────────────────────────────────────
// Restated locally, same discipline as lib/plan-baseline.ts: a drift in the
// schedule service's projection is a type error here rather than `undefined`
// under a money figure.

export type MaterialKind = 'material' | 'labour';
export type MovementKind = 'scope_change' | 'price_movement';
export type PriceCause = 'index' | 'supplier_quote' | 'correction';

/**
 * `closed_and_verified` is in the type because the contract froze three states,
 * but the service DECLINES to emit it in v1 — it needs the deferred
 * `stage_verified` stamp (contract §7). It is kept here, and stated on the
 * screen as "not recorded yet", rather than deleted: a state the record cannot
 * yet express is a gap to name, not one to pretend away.
 */
export type LineState = 'accepted' | 'deviation' | 'closed_and_verified';

/** One material or labour line behind a plan line. Quantities are fractional. */
export interface LineMaterial {
  id: string;
  stageId: string;
  projectId: string;
  planVersionId: string;
  kind: MaterialKind;
  name: string;
  unit: string;
  /** CURRENT quantity — the baseline row overridden by its latest movement (§1). */
  quantity: number;
  /** CURRENT unit price, same override. The BASELINE price is on the movement row. */
  unitPriceCents: number;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** One recorded post-baseline movement. Append-only: never edited, only followed. */
export interface MovementView {
  id: string;
  seq: number | null;
  projectId: string;
  lineMaterialId: string;
  stageId: string;
  movementKind: MovementKind;
  priceCause: PriceCause | null;
  newQuantity: number | null;
  newUnitPriceCents: number | null;
  valueDeltaCents: number;
  source: string | null;
  changeOrderId: string | null;
  movedByPartyId: string;
  occurredAt: string;
  auditEventId: string;
  createdAt: string;
}

export interface RecordLine {
  stageId: string;
  name: string;
  trade: string | null;
  position: number;
  state: LineState;
  plannedCostCents: number;
  currentValueCents: number;
  materials: LineMaterial[];
  /** Always present — Compare stays available on a settled line (§3a). */
  compare: { plannedCostCents: number; currentValueCents: number };
}

export type ProgressStatus = 'not_started' | 'in_progress' | 'done' | 'blocked';

export interface ScheduleLine {
  stageId: string;
  name: string;
  position: number;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  status: ProgressStatus;
  percent: number | null;
}

export interface RecordHistoryEvent {
  eventId: string;
  seq: number;
  type: string;
  actorPartyId: string | null;
  occurredAt: string;
  payload: Record<string, unknown> | null;
}

export interface ScopeChangeRow {
  movementId: string;
  stageId: string;
  lineMaterialId: string;
  valueDeltaCents: number;
  changeOrder: { id: string | null };
  movedByPartyId: string;
  occurredAt: string;
}

export interface PriceMovementRow {
  movementId: string;
  stageId: string;
  lineMaterialId: string;
  priceCause: PriceCause | null;
  source: string | null;
  /** The frozen baseline unit price — an index rise reads as a price delta (§3c). */
  baselineUnitPriceCents: number | null;
  newUnitPriceCents: number;
  valueDeltaCents: number;
  movedByPartyId: string;
  occurredAt: string;
}

/** `GET …/budget-movement` (§3c route 5), also embedded as the D14 Money tab. */
export interface MoneyView {
  baselineBudgetCents: number;
  currentBudgetCents: number;
  scopeChanges: ScopeChangeRow[];
  priceMovements: PriceMovementRow[];
}

/** `GET …/projects/{id}/record` (§3a route 1) — the whole D14 surface. */
export interface RecordView {
  state: LineState;
  baseline: { planVersionId: string; versionNo: number; frozenAt: string } | null;
  tabs: {
    plan: { lines: RecordLine[] };
    schedule: { lines: ScheduleLine[] };
    money: MoneyView;
    history: { events: RecordHistoryEvent[] };
  };
}

/** `GET …/stages/{stageId}/materials` (§3b route 2) — the whole D15 surface. */
export interface StageMaterialsView {
  lineMaterials: LineMaterial[];
  movements: MovementView[];
}

/** `POST …/stages/{stageId}/materials` (§3b route 3). */
export interface MaterialInput {
  kind: MaterialKind;
  name: string;
  unit: string;
  quantity: number;
  unitPriceCents: number;
  position?: number;
}

/** `POST …/stages/{stageId}/materials:swap` (§3b route 4). */
export interface SwapInput {
  lineMaterialId: string;
  movementKind: MovementKind;
  priceCause?: PriceCause;
  newQuantity?: number;
  newUnitPriceCents?: number;
  source?: string | null;
  changeOrder?: { title: string };
}

// ── Money, quantities, extended values ───────────────────────────────────────

/**
 * The extended value of a material line: quantity × unit price, rounded to whole
 * cents THE SAME WAY the server rounds it (materials.mjs `currentMaterialState`).
 * Rounding differently here would put a figure on the screen that is one cent
 * away from the one on the record — on a product whose promise is "how much did
 * it move", a cent of drift between what you were shown and what was stored is
 * the failure, not a rounding detail.
 */
export function extendedCents(m: Pick<LineMaterial, 'quantity' | 'unitPriceCents'>): number {
  return Math.round(m.quantity * m.unitPriceCents);
}

/**
 * Σ extended values of a line's materials. `null` — not 0 — when the line has no
 * breakdown: "$0.00 of materials" is a claim the record has not been given, and
 * a line may legitimately carry a planned cost with no breakdown yet (§7).
 */
export function materialsTotalCents(materials: LineMaterial[]): number | null {
  if (materials.length === 0) return null;
  return materials.reduce((sum, m) => sum + extendedCents(m), 0);
}

/**
 * The v1-advisory reconciliation (contract §7): does Σ materials agree with the
 * line's planned cost? Deliberately NOT a state and NOT an error — it is a soft
 * indicator. `no_breakdown` is its own answer rather than a mismatch of the whole
 * planned cost, which would flag every unpriced line as broken.
 */
export function reconcile(line: RecordLine): {
  kind: 'no_breakdown' | 'match' | 'mismatch';
  materialsCents: number | null;
  deltaCents: number;
} {
  const materialsCents = materialsTotalCents(line.materials);
  if (materialsCents == null) return { kind: 'no_breakdown', materialsCents: null, deltaCents: 0 };
  const deltaCents = materialsCents - line.plannedCostCents;
  return { kind: deltaCents === 0 ? 'match' : 'mismatch', materialsCents, deltaCents };
}

/** What Compare answers on any line, settled or not (§3a): planned → current. */
export function compareDelta(line: RecordLine): number {
  return line.compare.currentValueCents - line.compare.plannedCostCents;
}

/**
 * The D16 sums, kept APART on purpose and returned under names that say which is
 * which. There is deliberately no `total` field: the only place these two could
 * be added together is a caller that has decided to blur them, and this shape
 * gives it nothing to add.
 */
export function moneyTotals(view: MoneyView): {
  scopeChangeCents: number;
  priceMovementCents: number;
} {
  return {
    scopeChangeCents: view.scopeChanges.reduce((s, r) => s + r.valueDeltaCents, 0),
    priceMovementCents: view.priceMovements.reduce((s, r) => s + r.valueDeltaCents, 0),
  };
}

/** A fractional quantity, trimmed. `numeric(14,3)` — three decimals is the floor. */
export function formatQuantity(n: number): string {
  return Number(n.toFixed(3)).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

/**
 * A typed quantity → number. Refuses rather than rounds, like
 * `parseAmountToCents` in lib/format: a fourth decimal the column cannot hold
 * would be silently truncated into a different quantity, and the quantity is
 * half of every money figure on these screens.
 *
 * @throws Error with a message intended for direct display in the form.
 */
export function parseQuantity(raw: string): number {
  const cleaned = raw.trim().replace(/[\s,]/g, '');
  if (!/^\d+(\.\d{1,3})?$/.test(cleaned)) {
    throw new Error('Enter the quantity as a positive number with at most three decimals, e.g. 12 or 12.5');
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
    throw new Error('Enter a quantity between 0 and 1,000,000');
  }
  return n;
}

// ── States, labels, attribution ──────────────────────────────────────────────

export function stateLabel(state: LineState): string {
  switch (state) {
    case 'deviation': return 'Deviation';
    case 'closed_and_verified': return 'Closed and verified';
    default: return 'As agreed';
  }
}

export function stateTone(state: LineState): 'ok' | 'warn' | 'neutral' {
  return state === 'deviation' ? 'warn' : state === 'closed_and_verified' ? 'ok' : 'neutral';
}

export function priceCauseLabel(cause: PriceCause | null): string {
  switch (cause) {
    case 'index': return 'Index movement';
    case 'supplier_quote': return 'Supplier quote';
    case 'correction': return 'Correction';
    default: return 'Not stated';
  }
}

export function progressLabel(status: ProgressStatus): string {
  switch (status) {
    case 'in_progress': return 'In progress';
    case 'done': return 'Done';
    case 'blocked': return 'Blocked';
    default: return 'Not started';
  }
}

/**
 * The History tab reads the raw ledger types, so each one gets a sentence. An
 * unknown type falls back to the type string itself rather than being HIDDEN:
 * the tab's promise is the whole chain in order, and a row the UI has no copy
 * for is still a row that happened.
 */
export function eventSentence(type: string): string {
  switch (type) {
    case 'material_movement_recorded': return 'A material movement was recorded';
    case 'plan_imported': return 'A plan was imported';
    case 'plan_version_proposed': return 'A plan version was proposed';
    case 'plan_version_accepted': return 'A plan version was accepted';
    case 'plan_version_withdrawn': return 'A plan version was withdrawn';
    case 'plan_version_rejected': return 'A plan version was rejected';
    case 'change_order_proposed': return 'A change order was proposed';
    case 'change_order_approved': return 'A change order was approved';
    case 'change_order_rejected': return 'A change order was rejected';
    case 'decision_recorded': return 'A decision was recorded';
    case 'progress_reported': return 'Progress was reported';
    case 'budget_moved': return 'The budget moved';
    default: return type.replace(/_/g, ' ');
  }
}

/** Movements against one material, oldest first — the order the server returns. */
export function movementsForLine(movements: MovementView[], lineMaterialId: string): MovementView[] {
  return movements.filter((m) => m.lineMaterialId === lineMaterialId);
}

// ── Affordances (NOT the permission — §4 decides that, server-side) ──────────

/**
 * May this party author materials on this stage? Route 3 is open only while the
 * stage's plan version is `proposed` AND only to the party that proposed it.
 * Both halves matter: dropping the second shows an authoring form to the
 * reviewer, whose every submit would 403.
 */
export function canAuthorMaterials(
  plan: PlanBaselineView,
  stageId: string,
  actorPartyId: string | null,
): boolean {
  const current = plan.current;
  if (!current || current.status !== 'proposed') return false;
  if (!actorPartyId || actorPartyId !== current.proposedByPartyId) return false;
  return stageIsIn(current.stages, stageId);
}

/**
 * May this party record a movement? RECORD_MOVEMENT is the counterparty's (the
 * GC / executing side, §4), and a swap is POST-baseline only — before a baseline
 * exists there is nothing to move against, and the server answers `not_baselined`.
 */
export function canRecordMovement(
  plan: PlanBaselineView,
  actingRole: string | null,
): boolean {
  return plan.baseline !== null && actingRole === 'counterparty';
}

function stageIsIn(nodes: { id: string; children: { id: string; children: unknown[] }[] }[], stageId: string): boolean {
  for (const n of nodes) {
    if (n.id === stageId) return true;
    if (stageIsIn(n.children as never, stageId)) return true;
  }
  return false;
}

// ── The swap: what it will move, and whether it is well-formed ──────────────

export interface SwapDraft {
  movementKind: MovementKind;
  priceCause: PriceCause | '';
  /** Raw form text — parsed here so the screen has one refusal path. */
  quantity: string;
  unitPrice: string;
  source: string;
  changeOrderTitle: string;
}

export function emptySwapDraft(material: LineMaterial, kind: MovementKind): SwapDraft {
  return {
    movementKind: kind,
    priceCause: kind === 'price_movement' ? 'index' : '',
    quantity: formatQuantity(material.quantity),
    unitPrice: (material.unitPriceCents / 100).toFixed(2),
    source: '',
    changeOrderTitle: '',
  };
}

export class SwapDraftError extends Error {
  field: keyof SwapDraft;
  constructor(field: keyof SwapDraft, message: string) {
    super(message);
    this.name = 'SwapDraftError';
    this.field = field;
  }
}

/**
 * Draft → the exact `SwapInput` the contract froze, or a typed refusal naming
 * the field. The kind drives the shape (§3b):
 *   - scope_change   → needs a new quantity and a change-order title; must NOT
 *                      carry a price cause. Its money is realised by the CO.
 *   - price_movement → needs a new unit price and a price cause; must NOT carry
 *                      a change order. Its money moves nothing.
 * Emitting the wrong shape is not a validation nicety: it is the one way the UI
 * could file an index rise as a scope change.
 */
export function toSwapInput(
  material: LineMaterial,
  draft: SwapDraft,
  parseCents: (raw: string) => number,
): SwapInput {
  const source = draft.source.trim();
  if (source.length > 500) {
    throw new SwapDraftError('source', 'Keep the source under 500 characters.');
  }

  if (draft.movementKind === 'scope_change') {
    let quantity: number;
    try {
      quantity = parseQuantity(draft.quantity);
    } catch (err) {
      throw new SwapDraftError('quantity', (err as Error).message);
    }
    let unitPriceCents = material.unitPriceCents;
    if (draft.unitPrice.trim() !== '') {
      try {
        unitPriceCents = parseCents(draft.unitPrice);
      } catch (err) {
        throw new SwapDraftError('unitPrice', (err as Error).message);
      }
    }
    const title = draft.changeOrderTitle.trim();
    if (!title) {
      throw new SwapDraftError('changeOrderTitle',
        'A scope change opens a change order — give it a title the other party will recognise.');
    }
    if (quantity === material.quantity && unitPriceCents === material.unitPriceCents) {
      throw new SwapDraftError('quantity', 'Nothing has changed yet — move the quantity or the price first.');
    }
    return {
      lineMaterialId: material.id,
      movementKind: 'scope_change',
      newQuantity: quantity,
      newUnitPriceCents: unitPriceCents,
      source: source || null,
      changeOrder: { title },
    };
  }

  if (!draft.priceCause) {
    throw new SwapDraftError('priceCause', 'Say why the price moved — that is what makes it a price movement and not a scope change.');
  }
  let unitPriceCents: number;
  try {
    unitPriceCents = parseCents(draft.unitPrice);
  } catch (err) {
    throw new SwapDraftError('unitPrice', (err as Error).message);
  }
  if (unitPriceCents === material.unitPriceCents) {
    throw new SwapDraftError('unitPrice', 'The unit price is unchanged — a price movement records a price that moved.');
  }
  return {
    lineMaterialId: material.id,
    movementKind: 'price_movement',
    priceCause: draft.priceCause,
    newQuantity: material.quantity,
    newUnitPriceCents: unitPriceCents,
    source: source || null,
  };
}

/**
 * What this swap WOULD move, shown before it is sent. Mirrors the server's
 * arithmetic (round(newQty × newPrice) − round(priorQty × priorPrice)) so the
 * person recording it sees the figure they are about to put on the record — and
 * so a scope change's change order is never a surprise. It is a preview: the
 * value that lands is the server's, re-read after the write.
 */
export function swapPreview(material: LineMaterial, input: SwapInput): {
  priorExtendedCents: number;
  newExtendedCents: number;
  valueDeltaCents: number;
} {
  const priorExtendedCents = extendedCents(material);
  const quantity = input.newQuantity ?? material.quantity;
  const unitPriceCents = input.newUnitPriceCents ?? material.unitPriceCents;
  const newExtendedCents = Math.round(quantity * unitPriceCents);
  return { priorExtendedCents, newExtendedCents, valueDeltaCents: newExtendedCents - priorExtendedCents };
}

// ── The two writes (contract §3b routes 3 and 4) ─────────────────────────────

/** A refusal the server stated, carried with its code — same shape as B2's. */
export class RecordActionError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'RecordActionError';
    this.code = code;
    this.status = status;
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload: unknown = null;
  try { payload = await res.json(); } catch { /* a proxy error page */ }
  if (!res.ok) {
    const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new RecordActionError(
      err?.code ?? 'internal',
      err?.message ?? 'That did not go through. Try again.',
      res.status,
    );
  }
  return payload as T;
}

export function authorMaterials(
  stageId: string, materials: MaterialInput[],
): Promise<{ lineMaterials: LineMaterial[] }> {
  return post(`/api/v1/stages/${encodeURIComponent(stageId)}/materials`, { materials });
}

/**
 * The colon action, byte-identical to the contract: `…/materials:swap`. No actor
 * in the body — the acting party is the session's (ADR-0002 §5), and the cost
 * delta on the opened change order is the server's, never ours.
 */
export function swapMaterial(
  stageId: string, input: SwapInput,
): Promise<{ movement: MovementView; changeOrder?: { id: string; status: string; title: string } }> {
  return post(`/api/v1/stages/${encodeURIComponent(stageId)}/materials:swap`, input);
}
