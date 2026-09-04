/**
 * Paid-plan intent hand-off (LINA-175).
 *
 * When a paid plan CTA resolves to the `waitlist` flow (founding free seats
 * still remain — see /api/checkout), the visitor is sent to the existing
 * waitlist form instead of Stripe. The chosen plan travels with them so the
 * form can show what they picked and post it to /api/waitlist.
 *
 * sessionStorage rather than a query param: the CTA and the form live on the
 * same page, so this is an in-page hand-off, and reloading the landing page
 * with `?plan=` would cost a full navigation for no gain. The custom event
 * carries the intent to a form that is already mounted; the sessionStorage
 * read covers a form that mounts later (or a reload mid-session).
 */

export type PlanIntent = {
  /** Stable PaidPlanKey — see PAID_PLAN_KEYS in `@/lib/pricing`. */
  plan: string;
  /** Localized plan name as shown on the pricing card, for display only. */
  label: string;
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
    if (typeof parsed?.plan !== 'string' || !parsed.plan) return null;
    return { plan: parsed.plan, label: typeof parsed.label === 'string' ? parsed.label : parsed.plan };
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
