// The Slice B2 plan-baseline client contract — D11 / D12 / D12a / D13
// (LINA-212). Frozen contract: docs/architecture/slice-b2-plan-baseline-contract.md
// §5 (API) + §7 (FE).
//
// WHAT LIVES HERE AND WHY
// The wire types and the four transitions, plus the handful of pure functions
// the screens make decisions with. Everything in this file is either a
// restatement of what the server said or a derivation from it that can be
// unit-tested without a browser — the screens themselves are then copy and
// layout (plan-baseline.test.mjs covers the seams).
//
// THE RULES THIS FILE KEEPS (contract §5/§6):
//
//  1. THE ACTOR IS NEVER IN THE BODY. `:withdraw` and `:accept` send no body at
//     all and `:reject` / `:request-changes` send only their own fields. The
//     acting party comes from the session server-side; a client that could name
//     itself is a client that could stamp an acceptance as someone else, and
//     that stamp is the entire product.
//
//  2. NOTHING HERE DECIDES WHO MAY ACT. `canWithdraw` / `canReview` shape the
//     BUTTONS, not the permission: the server authorises every call against the
//     version row (§6) and a 403 renders as a 403. Hiding an affordance the
//     server would refuse is courtesy; it is not the check.
//
//  3. NO STRUCTURAL EDITS. `StageEdit` is dates and money only (§5). The diff
//     builder below cannot emit a name, a position or a parent even if a caller
//     passes one — B2 forks a version, it does not restructure a WBS.
//
//  4. NO CLIENT-SIDE MONEY CLAIMS ABOUT THE BUDGET. `totalCents` sums what the
//     stage rows say the plan is worth, which is a total OF THIS PLAN and not a
//     budget: B2 freezes the plan, B3 owns the money (contract §8).
//  5. NO RENDERING DEPENDENCY. Nothing here formats money or dates — the screen
//     does, with the formatters the rest of the portal already uses. That is
//     also what lets this module run under `node --test` unchanged.
import type { GanttScale } from './plan-import';

// ── Wire shapes (contract §5) ────────────────────────────────────────────────
// Restated locally on purpose, the same discipline as lib/view.ts: a drift in
// the schedule service's projection shows up as a type error here rather than
// as `undefined` on the acceptance banner.

/** One stage of a version's WBS tree. Dates are plain calendar dates. */
export interface PlanStageNode {
  id: string;
  name: string;
  position: number;
  trade: string | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  plannedCostCents: number | null;
  /**
   * Resolved predecessor STAGE IDS (LINA-233) — `[]` when none. Optional here
   * only because the read predates it and the older fixtures do not carry it;
   * the service always sends it (contract §0).
   */
  dependsOn?: string[];
  children: PlanStageNode[];
}

export type PlanVersionStatus = 'draft' | 'proposed' | 'withdrawn' | 'rejected' | 'superseded' | 'accepted';

/** A party's stamp on a version. `kind: 'proposed'` is authorship (§2). */
export interface PlanAcceptance {
  partyId: string;
  role: string | null;
  kind: 'proposed' | 'accepted';
  stampedAt: string;
}

export interface PlanVersionSummary {
  id: string;
  /** null while `draft` — a draft is unnumbered until it is proposed (LINA-230). */
  versionNo: number | null;
  status: PlanVersionStatus;
  sourceImportId: string | null;
  supersedesVersionId: string | null;
  proposedByPartyId: string;
  createdAt: string;
  frozenAt: string | null;
  acceptances: PlanAcceptance[];
}

/** The open version, with its stage tree. */
export interface PlanVersionView extends PlanVersionSummary {
  stages: PlanStageNode[];
}

export interface BaselineRef {
  planVersionId: string;
  versionNo: number;
  frozenAt: string;
}

/** `GET /api/v1/projects/:id/plan` (§5 route 1) — the whole D11–D13 surface. */
export interface PlanBaselineView {
  baseline: BaselineRef | null;
  current: PlanVersionView | null;
  history: PlanVersionSummary[];
}

/** The narrow D12a patch: dates and money only, per stage (§5). */
export interface StageEdit {
  stageId: string;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  plannedCostCents?: number;
}

// ── The row view model ───────────────────────────────────────────────────────

/**
 * A stage flattened for the table, with the dates aliased to the names the B1
 * mini-gantt already reads (`start`/`end`). This is the adapter that makes
 * "reuse the B1 preview components" (§7) literal rather than aspirational:
 * `ganttScale`, `barGeometry` and `dateRange` are called on these rows unchanged,
 * so a bar drawn on the proposal screen is drawn by the same code the GC
 * confirmed the import with.
 */
export interface StageRow {
  id: string;
  name: string;
  trade: string | null;
  start: string | null;
  end: string | null;
  costCents: number | null;
  children: StageRow[];
}

export function toRows(nodes: PlanStageNode[]): StageRow[] {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    trade: n.trade,
    start: n.plannedStartDate,
    end: n.plannedEndDate,
    costCents: n.plannedCostCents,
    children: toRows(n.children),
  }));
}

/**
 * Σ planned cost across the whole tree, in cents — or null when NO stage carries
 * a cost at all.
 *
 * Null and not 0: a plan nobody has priced has no value, and "$0.00" is a claim
 * about the money that the record has not been told. Stages that individually
 * carry no cost are skipped rather than counted as zero, for the same reason —
 * the total then reads "of the stages that are priced", which is what it is.
 */
export function totalCents(rows: StageRow[]): number | null {
  let sum = 0;
  let seen = false;
  const visit = (r: StageRow) => {
    if (r.costCents != null) { sum += r.costCents; seen = true; }
    r.children.forEach(visit);
  };
  rows.forEach(visit);
  return seen ? sum : null;
}

/** Counts for the table footer — top-level actions and everything beneath them. */
export function stageCounts(rows: StageRow[]): { actions: number; subActions: number; total: number } {
  let subActions = 0;
  const visit = (r: StageRow) => { subActions += r.children.length; r.children.forEach(visit); };
  rows.forEach(visit);
  return { actions: rows.length, subActions, total: rows.length + subActions };
}

// ── Who has stamped, who is awaited (D11/D13 banner, §7) ─────────────────────

export interface StampState {
  /** The authorship stamp — always present on a version the server created. */
  proposed: PlanAcceptance | null;
  /** The reviewer's acceptance stamp. Present only once the version is accepted. */
  accepted: PlanAcceptance | null;
}

export function stamps(version: Pick<PlanVersionSummary, 'acceptances'>): StampState {
  return {
    proposed: version.acceptances.find((a) => a.kind === 'proposed') ?? null,
    accepted: version.acceptances.find((a) => a.kind === 'accepted') ?? null,
  };
}

/**
 * The party this version is waiting on, or null when it is not waiting on anyone
 * (accepted, or terminal).
 *
 * Derived from the stamps rather than from the roles: the roles SWAP on a
 * request-changes fork (§1), so "the owner is always the reviewer" is true of v1
 * only and would put the wrong name in the banner on v2 — which on this screen is
 * a wrong answer to "who is this waiting for".
 */
export function awaitedPartyId(
  version: Pick<PlanVersionSummary, 'status' | 'proposedByPartyId' | 'acceptances'>,
  members: { partyId: string }[],
): string | null {
  if (version.status !== 'proposed') return null;
  const stamped = new Set(version.acceptances.map((a) => a.partyId));
  const other = members.find((m) => m.partyId !== version.proposedByPartyId && !stamped.has(m.partyId));
  return other?.partyId ?? null;
}

/** The proposer may retract while the proposal is still open (§6, D11). */
export function canWithdraw(
  version: Pick<PlanVersionSummary, 'status' | 'proposedByPartyId'>,
  actorPartyId: string | null,
): boolean {
  return version.status === 'proposed' && !!actorPartyId && actorPartyId === version.proposedByPartyId;
}

/** The OTHER party reviews: accept / request changes / reject (§6, D12). */
export function canReview(
  version: Pick<PlanVersionSummary, 'status' | 'proposedByPartyId'>,
  actorPartyId: string | null,
): boolean {
  return version.status === 'proposed' && !!actorPartyId && actorPartyId !== version.proposedByPartyId;
}

// ── The D12a diff ────────────────────────────────────────────────────────────

/** What one stage's editable fields hold in the D12a form, as typed strings. */
export interface StageDraft {
  start: string;
  end: string;
  /** The amount as typed, in currency units — parsed to cents on submit. */
  cost: string;
}

/** The draft a row starts from: exactly what the current version says. */
export function draftOf(row: StageRow): StageDraft {
  return {
    start: row.start ?? '',
    end: row.end ?? '',
    cost: row.costCents == null ? '' : (row.costCents / 100).toFixed(2),
  };
}

export class StageEditError extends Error {
  // Explicit fields rather than TS parameter properties: these modules are also
  // imported by `node --test` under strip-only type-stripping, which cannot
  // desugar a parameter property (the same reason PlanImportError is written
  // this way).
  stageId: string;

  constructor(stageId: string, message: string) {
    super(message);
    this.name = 'StageEditError';
    this.stageId = stageId;
  }
}

/**
 * Turn the drafts into the `StageEdit[]` the server forks on — ONLY the fields
 * that actually changed, and only for the stages that changed at all.
 *
 * Sending an unchanged field would be harmless to the data (the fork copies it
 * either way) and dishonest on the screen: the request-changes event is the
 * owner's statement of WHAT THEY ASKED TO CHANGE, and a patch that restates every
 * date on the plan says they asked to change all of them.
 *
 * Throws a `StageEditError` naming the stage when an amount cannot be parsed —
 * the same refuse-rather-than-round rule as `parseAmountToCents` (a rounded
 * counter-offer is a number nobody typed).
 */
export function diffEdits(rows: StageRow[], drafts: Record<string, StageDraft>): StageEdit[] {
  const out: StageEdit[] = [];
  const visit = (r: StageRow) => {
    const d = drafts[r.id];
    if (d) {
      const edit: StageEdit = { stageId: r.id };
      let changed = false;

      const start = d.start.trim() || null;
      if (start !== (r.start ?? null)) {
        if (start !== null && !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
          throw new StageEditError(r.id, `“${r.name}”: enter the start as a date, or clear it.`);
        }
        edit.plannedStartDate = start;
        changed = true;
      }

      const end = d.end.trim() || null;
      if (end !== (r.end ?? null)) {
        if (end !== null && !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
          throw new StageEditError(r.id, `“${r.name}”: enter the end as a date, or clear it.`);
        }
        edit.plannedEndDate = end;
        changed = true;
      }

      // Money: cleared is NOT the same as unchanged and NOT the same as zero. The
      // wire has no "unset the cost" (§5: plannedCostCents is an integer), so a
      // cleared field is refused rather than silently sent as 0 — dropping a
      // stage's price to zero because a field was emptied is exactly the kind of
      // money claim nobody made.
      const cost = d.cost.trim();
      if (cost === '' && r.costCents != null) {
        throw new StageEditError(r.id, `“${r.name}”: a value cannot be removed here — put back the amount, or leave it as it was.`);
      }
      if (cost !== '') {
        let cents: number;
        try {
          cents = parseCostCents(cost);
        } catch {
          throw new StageEditError(r.id, `“${r.name}”: enter the value as an amount with at most two decimals.`);
        }
        if (cents !== r.costCents) { edit.plannedCostCents = cents; changed = true; }
      }

      if (changed) out.push(edit);
    }
    r.children.forEach(visit);
  };
  rows.forEach(visit);
  return out;
}

/** A planned value: never negative — a stage that costs less than nothing is a
 *  typo, and the server's `plannedCostCents` is an integer count of cents. */
function parseCostCents(raw: string): number {
  const cleaned = raw.trim().replace(/[\s,]/g, '').replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error('unparseable');
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('too large');
  return cents;
}

/**
 * What one edit changed, before and after — as DATA, not as a sentence.
 *
 * The money stays integer cents and the dates stay wire dates: formatting is the
 * screen's job (`moneyPrecise`, `dateRange`), and keeping it there is what lets
 * this run under `node --test` with no rendering dependency at all.
 */
export interface EditSummary {
  dates?: {
    from: { start: string | null; end: string | null };
    to: { start: string | null; end: string | null };
  };
  value?: { fromCents: number | null; toCents: number };
}

export function describeEdit(row: StageRow, edit: StageEdit): EditSummary {
  const out: EditSummary = {};
  if (edit.plannedStartDate !== undefined || edit.plannedEndDate !== undefined) {
    out.dates = {
      from: { start: row.start, end: row.end },
      to: {
        start: edit.plannedStartDate !== undefined ? edit.plannedStartDate : row.start,
        end: edit.plannedEndDate !== undefined ? edit.plannedEndDate : row.end,
      },
    };
  }
  if (edit.plannedCostCents !== undefined) {
    out.value = { fromCents: row.costCents, toCents: edit.plannedCostCents };
  }
  return out;
}

/** Σ of the plan as it would stand after the edits — for the D12a delta line. */
export function totalAfter(rows: StageRow[], edits: StageEdit[]): number | null {
  const byId = new Map(edits.map((e) => [e.stageId, e]));
  let sum = 0;
  let seen = false;
  const visit = (r: StageRow) => {
    const e = byId.get(r.id);
    const cents = e?.plannedCostCents !== undefined ? e.plannedCostCents : r.costCents;
    if (cents != null) { sum += cents; seen = true; }
    r.children.forEach(visit);
  };
  rows.forEach(visit);
  return seen ? sum : null;
}

// ── The transitions (contract §5 routes 2–5) ─────────────────────────────────

/** A refusal the server stated, carried with its code so a screen reacts to the
 *  KIND of failure rather than to a substring of English. */
export class PlanActionError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'PlanActionError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The action URL, byte-identical to the contract: `…/plan-versions/{id}:action`.
 * The colon action is part of the path segment, which is why the route file is a
 * single `[versionAction]` segment split server-side rather than four routes.
 */
function actionUrl(projectId: string, versionId: string, action: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/plan-versions/${
    encodeURIComponent(`${versionId}:${action}`)}`;
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: unknown = null;
  try { payload = await res.json(); } catch { /* a 204 or a proxy error page */ }
  if (!res.ok) {
    const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new PlanActionError(
      err?.code ?? 'internal',
      err?.message ?? 'That did not go through. Try again.',
      res.status,
    );
  }
  return payload as T;
}

export function withdrawVersion(projectId: string, versionId: string): Promise<{ status: 'withdrawn' }> {
  return post(actionUrl(projectId, versionId, 'withdraw'));
}

export function acceptVersion(
  projectId: string, versionId: string,
): Promise<{ status: PlanVersionStatus; baseline?: BaselineRef | null }> {
  return post(actionUrl(projectId, versionId, 'accept'));
}

export function rejectVersion(
  projectId: string, versionId: string, reason?: string,
): Promise<{ status: 'rejected' }> {
  // An empty box is "no reason given", not an empty reason: the server takes
  // `reason?` and records null, which is the honest state.
  const trimmed = reason?.trim();
  return post(actionUrl(projectId, versionId, 'reject'), trimmed ? { reason: trimmed } : {});
}

export function requestChanges(
  projectId: string, versionId: string, stages: StageEdit[],
): Promise<{ newVersionId: string; versionNo: number; status: 'proposed' }> {
  return post(actionUrl(projectId, versionId, 'request-changes'), { stages });
}

/**
 * "Send for approval" (LINA-230): a draft → proposed. The first moment the other
 * party sees the plan and the first moment approval is requested — a deliberate
 * second act, separate from saving. No body; the actor is the session, and the
 * server refuses anyone but the drafter (403).
 */
export function proposeVersion(
  projectId: string, versionId: string,
): Promise<{ planVersionId: string; versionNo: number; status: 'proposed' }> {
  return post(actionUrl(projectId, versionId, 'propose'));
}

// Re-exported so a screen imports its whole plan vocabulary from one module.
export type { GanttScale };
