'use client';

// The one form primitive the write surfaces share (LINA-57).
//
// Three things it guarantees, all of which are easy to forget per-form and all
// of which matter on a record people argue over:
//
//  * The pending state disables the submit button. A double-submitted invite
//    mints two tokens; a double-submitted change order proposes it twice, and
//    both land in the audit trail forever.
//  * Failures render in `role="alert"` NEXT TO the inputs, not on an error page,
//    so the typed values survive and the message is announced to a screen reader.
//  * The error is text — never colour alone (FR9 accessibility), and it carries
//    an icon glyph plus a "Couldn't …" sentence.
import { useActionState } from 'react';

import type { PlanLimit } from '@/lib/api';
import { PlanLimitNotice } from './PlanLimitNotice';

/**
 * One state shape for every action rather than a generic parameter. The optional
 * `token` is the only field beyond `error` any R0 form returns, and threading a
 * generic through `useActionState`'s `Awaited<S>` signature costs more in
 * type gymnastics than the union saves.
 */
export interface ActionState {
  error?: string;
  /** The one-time invitation code. Never persisted — see the invite panel. */
  token?: string;
  /** Invite-by-email (LINA-84): the address it went to, and whether it was sent. */
  sentTo?: string;
  emailed?: boolean;
  /**
   * The plan allowance, when the failure was `409 plan_limit_reached` (LINA-205).
   *
   * Set ALONGSIDE `error`, never instead of it: an action that forgets to render
   * the panel still says something, and the service's own sentence stays the
   * fallback everywhere this state travels.
   */
  planLimit?: PlanLimit;
}

export function ActionForm({
  action,
  initialState = {},
  submitLabel,
  pendingLabel,
  children,
  render,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  initialState?: ActionState;
  submitLabel: string;
  pendingLabel?: string;
  children?: React.ReactNode;
  /** Optional extra output driven by the returned state (e.g. the invite token). */
  render?: (state: ActionState) => React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <form action={formAction} className="stack">
      {children}
      {/* The plan refusal REPLACES the red strip rather than sitting above it
          (LINA-205). Both would say the same thing twice, and one of the two
          would be saying it in the colour reserved for "you typed something
          wrong" — which this is not. The panel prints the same facts the
          sentence carries, plus the ways forward. */}
      {state?.planLimit ? (
        <PlanLimitNotice entitlement={state.planLimit} />
      ) : state?.error ? (
        <p className="form-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {state.error}
        </p>
      ) : null}
      {/* The submit stays, and is deliberately NOT hidden on the plan refusal.
          It looks like an invitation to retry a request that just failed, but the
          allowance is a fact about the world and not about this form: an owner
          who opens the portfolio in another tab, or whose plan is raised while
          this page is open, resolves it without a reload. Taking the button away
          would strand them on a dead screen with their typed name and budget
          still in it. */}
      <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
        {pending ? (pendingLabel ?? 'Working…') : submitLabel}
      </button>
      {render ? render(state) : null}
    </form>
  );
}
