// Shared API error vocabulary for the surfaces (LINA-57).
//
// ── WHAT THIS FILE IS NOW ────────────────────────────────────────────────────
// This used to be the v1 data-access layer — the ROUTES table, the two
// transports (in-process / HTTP), and the invitation helpers that drove the last
// retained v1 slice. Phase 12 cut every surface over to `/api/v2` (see
// `lib/v2/client.ts`), and LINA-398 moved the invitation accept deep link across
// too, so the v1 transport and its `@services` imports are DELETED here rather
// than merely dormant. There is no `/api/v1` and no `@services` reference left in
// this file — the v1 deprecation gate in CI no longer needs to whitelist it.
//
// What survives is the error vocabulary the server actions and a couple of
// components still speak (`ApiError`, `PlanLimitError`, `PlanLimit`) plus the
// `isSignedIn` probe, re-exported from its home in `@/server/session` so the many
// surfaces that import it from here keep working unchanged.
export { isSignedIn } from '@/server/session';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when there is no signed-in party. Surfaces route to sign-in. */
export class UnauthenticatedError extends ApiError {
  constructor() {
    super(401, 'Sign in to view this record', 'unauthenticated');
    this.name = 'UnauthenticatedError';
  }
}

/**
 * The plan allowance, exactly as the service stated it (LINA-205, ADR-0013).
 *
 * These three numbers are on the wire SPECIFICALLY so this app does not keep a
 * second copy of the pricing table. `limit` is what the seat's plan runs;
 * `owned` is what the party already owns. Neither is ever re-derived here — the
 * allowance lives server-side and re-pricing must not require a front-end deploy
 * to stay truthful.
 */
export interface PlanLimit {
  /** The plan key on the seat, or null for a seat that carries none. */
  plan: string | null;
  /** How many builds that plan runs at once. Never null here: an unlimited tier never refuses. */
  limit: number;
  /** How many the party already owns. Equal to `limit` at the moment of refusal. */
  owned: number;
}

/**
 * `409 plan_limit_reached`. A subclass rather than a flag on ApiError so a
 * surface that wants the plan-aware screen asks for it by type, and every other
 * catch site keeps treating it as the ApiError it already handles.
 *
 * 409 and not 402/403 is deliberate and reasoned in ADR-0013: 403 says "you may
 * never do this", and the honest statement is "you already run as many builds as
 * your plan allows" — a collision with reality the owner resolves. The
 * specificity lives in `code`, which is stable.
 */
export class PlanLimitError extends ApiError {
  constructor(status: number, message: string, public entitlement: PlanLimit) {
    super(status, message, 'plan_limit_reached');
    this.name = 'PlanLimitError';
  }
}
