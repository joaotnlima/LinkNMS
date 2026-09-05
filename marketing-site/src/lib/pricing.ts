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

/**
 * The free founding seat (LINA-180). A valid PLAN_KEYS value, but never a
 * checkout plan: claiming it means "I want one of the founding 50", which is
 * recorded on the waitlist signup. `/api/checkout` counts exactly these rows
 * to decide when paid CTAs flip from the waitlist to Stripe, so the free CTA
 * has to record the intent like a paid CTA does.
 */
export const FREE_FOUNDING_PLAN_KEY = 'free_founding';
export type FreeFoundingPlanKey = typeof FREE_FOUNDING_PLAN_KEY;

/** Any plan a landing CTA can hand to the waitlist form. */
export type PlanIntentKey = PaidPlanKey | FreeFoundingPlanKey;

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

// ── Persona (LINA-189) ───────────────────────────────────────────────────────
//
// The two people this product is sold to, and the two it is built around: the
// OWNER having the house built, and the BUILDER doing or managing the work.
// The whole landing page is already organised around exactly this split — the
// pricing section's Owner/Builder tabs, the two ribbons, the two plan families
// — but until now the split was purely presentational: whichever side of it a
// visitor came in through, the signup row looked identical.
//
// That matters because it is the one fact about a new signup we can know
// WITHOUT asking. The role dropdown asks a six-way question that a visitor may
// skip (and should be able to skip — an email address is enough to send a
// confirmation link). Which CTA they pressed is not a question at all; it is
// something they already told us by clicking.
//
// The persona then rides the whole way through: signup → confirmation → the
// portal's sign-up → the account-setup screen, which preselects Owner or
// General contractor instead of asking a person to state, for a second time,
// something they picked on the pricing page a minute earlier.

export const PERSONAS = ['owner', 'builder'] as const;
export type Persona = (typeof PERSONAS)[number];

export function isPersona(value: unknown): value is Persona {
  return typeof value === 'string' && (PERSONAS as readonly string[]).includes(value);
}

/** Only a known persona survives; anything else is dropped to null. */
export function normalizePersona(value: unknown): Persona | null {
  return isPersona(value) ? value : null;
}

/**
 * The persona a plan belongs to — the authoritative derivation.
 *
 * Every paid plan lives under exactly one of the two pricing tabs, so the plan
 * key alone determines the persona and the server can derive it rather than
 * trust it. That is the point: a client-supplied persona is a hint, but a
 * client-supplied persona that CONTRADICTS the plan it arrived with is either a
 * bug or a forgery, and in both cases the plan is the thing the visitor
 * actually chose. See /api/waitlist, where the plan wins.
 *
 * `free_founding` returns null, not 'owner'. The founding CTA sits in the owner
 * ribbon today, but the seat itself is not an owner plan — it is a seat, and a
 * builder claiming one is a real case, not a mistake. Guessing 'owner' here
 * would put the wrong role in front of every builder who takes a founding seat,
 * which is exactly the friction this is meant to remove. For that CTA the
 * persona comes from the ribbon that rendered it, declared explicitly.
 */
const PLAN_PERSONA: Record<PaidPlanKey, Persona> = {
  personal: 'owner',
  build_plus: 'owner',
  real_estate_investor: 'owner',
  independent_builder: 'builder',
  growing_builder: 'builder',
  construction_business: 'builder'
};

export function personaForPlan(plan: unknown): Persona | null {
  return isPaidPlanKey(plan) ? PLAN_PERSONA[plan] : null;
}

/**
 * The account-setup role this persona should preselect in the portal.
 *
 * The portal speaks `owner | general_contractor` (the two options on
 * /onboarding/setup). This is the one place the landing site's vocabulary is
 * translated into the portal's, so the two can be renamed independently.
 */
export function setupRoleForPersona(persona: Persona): 'owner' | 'general_contractor' {
  return persona === 'owner' ? 'owner' : 'general_contractor';
}