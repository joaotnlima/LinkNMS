// Pure v2-phase wire → view transforms for the plan surface's phase list and the
// execution sign-off panel (LINA-323, S6 of the UI cutover, doc 22 §3). Split out
// of `phases.ts` (which does the I/O and imports `server-only`) so every mapping
// is unit-testable without a Clerk session or a router — the same discipline as
// `planning-view.ts` / `tendering-view.ts`.
//
// ── WHY THIS REPROJECTS RATHER THAN CONSUMES THE WIRE DIRECTLY ───────────────
// The sign-off UI (`@/components/SignOffPanel`) and its pure rules
// (`@/lib/phase-signoff`) predate the v2 cutover; they render a camelCase
// `ExecutionPhase`/`SignOffRequest` view (LINA-282). The v2 phase contract
// (modules/project/application/phases.mjs, ADR-0024) is snake_case and
// org-centric. Rather than fork the panel per transport, this file maps the v2
// wire ONTO the view the panel already renders — so the panel, its rules, and
// its tests stay one implementation across the v1→v2 cut.
//
// ── THE RULES THIS FILE KEEPS ────────────────────────────────────────────────
//  1. NAMES ARE NEVER INVENTED. The v2 sign-off projection carries `requested_by`
//     (a person id) but NOT a resolved display name (`signOffBody`,
//     application/phases.mjs). So `requestedByName`/`resolvedByName` stay null and
//     the panel falls back to "the other party"/"the approver" — never a guess.
//  2. ENUMS ARE PASSED THROUGH VERBATIM. v2 phase.status and sign-off.status
//     already match the view's `PhaseStatus`/`SignOffStatus` unions 1:1 (ADR-0024
//     kept the v1 vocabulary). A BE widening would surface as a type error here
//     rather than a silent coercion.
//  3. THE SELF-APPROVAL BAR IS MIRRORED, NOT INVENTED. `signOffViewer` derives
//     `canDecide` as "there is a pending request I did not open" — the same read
//     the v1 accordion used (plan/page.tsx @ f062988). The API is the authority
//     (`two_sided_rule`, phases.mjs); this only shapes buttons.

import type {
  ExecutionPhase, SignOffRequest, SignOffStatus, PhaseStatus, SignOffViewerContext,
} from '@/lib/phase-signoff';

// ── Wire shapes (verbatim against modules/project/application/phases.mjs
// signOffBody/phaseBody and cowork/documentation/api/v2/openapi.yaml). Restated
// locally, the same discipline as planning-view.ts: a drift in the module's
// projection lands as a type error here, not as `undefined` under the panel.

/** #/components/schemas/PhaseSignOffRequest — signOffBody(). */
export interface V2WireSignOff {
  id: string;
  phase_id: string;
  requested_by: string;
  requested_at: string;
  status: SignOffStatus;
  resolved_at: string | null;
  resolution_comment: string | null;
}

/** #/components/schemas/ProjectPhase — phaseBody(), plus the sign-off history the
 *  listPhases projection joins so the panel renders in one round-trip. */
export interface V2WirePhase {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  status: PhaseStatus;
  sequence: number;
  responsible_party_ids: string[];
  created_at: string;
  updated_at: string;
  sign_off_requests: V2WireSignOff[];
}

/**
 * A phase in the view the accordion + SignOffPanel render. A superset of
 * `ExecutionPhase` (adds the header identity — kind/name/sequence — the accordion
 * needs), so it drops straight into `signOffControls`/`SignOffPanel` unchanged.
 */
export interface V2Phase extends ExecutionPhase {
  projectId: string;
  kind: string;
  name: string;
  sequence: number;
  responsiblePartyIds: string[];
}

function toSignOff(s: V2WireSignOff): SignOffRequest {
  return {
    id: s.id,
    requestedBy: s.requested_by,
    requestedAt: s.requested_at,
    status: s.status,
    resolvedAt: s.resolved_at,
    resolutionComment: s.resolution_comment,
    // The v2 projection joins no display names (rule 1) — the panel resolves them
    // from its `partyNames` map, or falls back. Never fabricated here.
    requestedByName: null,
    resolvedByName: null,
  };
}

export function toPhase(p: V2WirePhase): V2Phase {
  return {
    id: p.id,
    projectId: p.project_id,
    kind: p.kind,
    name: p.name,
    status: p.status,
    sequence: p.sequence,
    responsiblePartyIds: p.responsible_party_ids ?? [],
    // Newest-first, matching the view's contract (ADR-0023 §2 append-only): the
    // panel and `phase-signoff` sort defensively too, but hand them the order
    // they expect so history reads correctly even where they don't re-sort.
    signOffRequests: [...(p.sign_off_requests ?? [])]
      .map(toSignOff)
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1)),
  };
}

/** The execution phase — the one that carries the plan grid and gets signed off
 *  (ADR-0024). Keyed on `kind`, not sequence, so a future phase insert cannot
 *  silently repoint sign-off at the wrong section. Null when unseeded. */
export function executionPhase(phases: V2Phase[]): V2Phase | null {
  return phases.find((p) => p.kind === 'execution') ?? null;
}

/**
 * The sign-off viewer context for the current person, mirroring the v1 accordion
 * (plan/page.tsx @ f062988): every participant may REQUEST (there is no role gate
 * — the plan is a two-party agreement), and may DECIDE any pending request they
 * did not open themselves. `requested_by` is a person id (phases.mjs
 * `insertSignOffRequest({ requestedBy: actor.id })`), so `myPersonId` is compared
 * against it directly. The API enforces the real bars (participation to request,
 * `two_sided_rule` to approve); this only shapes which controls show.
 */
export function signOffViewer(
  phase: V2Phase | null,
  myPersonId: string | null,
): SignOffViewerContext {
  // The one live request, or null. Append-only history (ADR-0023 §2) means
  // `pending` is the only status that can be open, and the partial unique index
  // guarantees at most one — the same read as `openRequest` in `phase-signoff`,
  // inlined here to keep this module's `@/` imports type-only (so its unit test
  // runs under `node --experimental-strip-types`).
  const pending = phase?.signOffRequests?.find((r) => r.status === 'pending') ?? null;
  return {
    partyId: myPersonId,
    canRequest: true,
    canDecide: pending !== null && pending.requestedBy !== myPersonId,
  };
}
