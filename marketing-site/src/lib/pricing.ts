/**
 * Pricing model for the landing page (LINA-173).
 *
 * Plan keys align with LINA-172's PLAN_KEYS enum in `@/lib/db`. The free
 * founding seat (`free_founding`) is NOT a checkout plan — it is claimed via
 * the waitlist while seats remain. Every other plan routes through Stripe
 * Checkout once the founding-50 are claimed; until then, paid intent is
 * collected through the waitlist flow (founder's charge-mode decision).
 */

export const PAID_PLAN_KEYS = [
  'personal',
  'build_plus',
  'real_estate_investor',
  'independent_builder',
  'growing_builder',
  'construction_business'
] as const;
export type PaidPlanKey = (typeof PAID_PLAN_KEYS)[number];

export function isPaidPlanKey(value: unknown): value is PaidPlanKey {
  return (
    typeof value === 'string' && (PAID_PLAN_KEYS as readonly string[]).includes(value)
  );
}

/** Monthly gross price shown on the pen/pricing section, per plan (EUR). */
export const PLAN_PRICE_EUR: Record<PaidPlanKey, number> = {
  personal: 19,
  build_plus: 49,
  real_estate_investor: 99,
  independent_builder: 59,
  growing_builder: 119,
  construction_business: 199
};

/**
 * Env var holding the Stripe Price ID for each paid plan. Values live in the
 * Vercel prod env (never in the repo); the Stripe Dashboard is the single
 * source of truth for the actual amount. The label here must stay a substring
 * of the dashboard plan naming so the mapping is reviewable.
 */
export const PLAN_PRICE_ENV: Record<PaidPlanKey, string> = {
  personal: 'STRIPE_PRICE_ID_PERSONAL',
  build_plus: 'STRIPE_PRICE_ID_BUILD_PLUS',
  real_estate_investor: 'STRIPE_PRICE_ID_REAL_ESTATE_INVESTOR',
  independent_builder: 'STRIPE_PRICE_ID_INDEPENDENT_BUILDER',
  growing_builder: 'STRIPE_PRICE_ID_GROWING_BUILDER',
  construction_business: 'STRIPE_PRICE_ID_CONSTRUCTION_BUSINESS'
};

export function priceIdForPlan(plan: PaidPlanKey): string | null {
  return process.env[PLAN_PRICE_ENV[plan]] || null;
}

/** Checkout needs the secret key AND every paid plan to have a price ID. */
export function isStripeConfigured(): boolean {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PUBLISHABLE_KEY) {
    return false;
  }
  return PAID_PLAN_KEYS.every((key) => Boolean(priceIdForPlan(key)));
}

/** Free founding seats reserve the "free" tier until 50 claims (LINA-172). */
export const FOUNDING_SEATS_TOTAL = 50;