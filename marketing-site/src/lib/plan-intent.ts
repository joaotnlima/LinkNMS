/**
 * CTA intent hand-off (LINA-175; persona added in LINA-189).
 *
 * When a paid plan CTA resolves to the `waitlist` flow (founding free seats
 * still remain — see /api/checkout), the visitor is sent to the existing
 * waitlist form instead of Stripe. The chosen plan travels with them so the
 * form can show what they picked and post it to /api/waitlist.
 *
 * Since LINA-189 an intent may carry a plan, a persona, or both — the builder
 * ribbon has a persona and no plan, and it is still worth knowing that a signup
 * came in through the builder side of the page.
 *
 * sessionStorage rather than a query param: the CTA and the form live on the
 * same page, so this is an in-page hand-off, and reloading the landing page
 * with `?plan=` would cost a full navigation for no gain. The custom event
 * carries the intent to a form that is already mounted; the sessionStorage
 * read covers a form that mounts later (or a reload mid-session).
 */

export type PlanIntent = {
  /**
   * Stable PaidPlanKey — see PAID_PLAN_KEYS in `@/lib/pricing`. Empty string
   * for a persona-only intent (a CTA that expresses who the visitor is without
   * choosing a plan); the form treats that as "no plan picked".
   */
  plan: string;
  /** Localized plan name as shown on the pricing card, for display only. */
  label: string;
  /**
   * Which side of the Owner/Builder split this CTA was rendered on (LINA-189).
   *
   * A HINT, not a fact. For a paid plan the server derives the persona from the
   * plan key and ignores this entirely — see `personaForPlan`. It is load-
   * bearing only for `free_founding`, whose plan key genuinely does not imply a
   * persona, and for the builder ribbon, which carries no plan at all.
   */
  persona?: string;
};

const KEY = 'lnms_plan_intent';

export const PLAN_INTENT_EVENT = 'lnms:plan-intent';

export function setPlanIntent(intent: PlanIntent): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    /* storage blocked — the event below still reaches a mounted form */
  }
  window.dispatchEvent(new CustomEvent<PlanIntent>(PLAN_INTENT_EVENT, { detail: intent }));
}

export function getPlanIntent(): PlanIntent | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlanIntent>;
    const plan = typeof parsed?.plan === 'string' ? parsed.plan : '';
    const persona = typeof parsed?.persona === 'string' ? parsed.persona : '';
    // An intent with neither is nothing to hand over.
    if (!plan && !persona) return null;
    return {
      plan,
      label: typeof parsed?.label === 'string' ? parsed.label : plan,
      ...(persona ? { persona } : {})
    };
  } catch {
    return null;
  }
}

export function clearPlanIntent(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
