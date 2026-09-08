// Plan DISPLAY NAMES for the portal (LINA-205, ADR-0013).
//
// ── WHAT THIS FILE IS ALLOWED TO KNOW ────────────────────────────────────────
// Names only. Not allowances, not prices, not feature lists.
//
// The allowance is the whole reason this is a hard line. `services/identity/
// plans.mjs` owns how many builds a plan runs, and the refusal puts `limit` and
// `owned` on the wire precisely so no screen has to re-derive them. A second
// copy here would be a pricing table that drifts silently: the founder re-prices
// `build_plus` from 10 to 15, the server starts allowing 15, and this screen goes
// on telling an owner their plan runs 10. On a product whose promise is that the
// record does not lie, that is the same class of bug as an invented number.
//
// A name cannot drift the same way, because a plan whose display name changed is
// a plan the marketing copy renamed — and if this map falls behind, `planLabel`
// returns null and the surface says "your current plan", which is true of every
// plan there will ever be.
//
// ── WHERE THE NAMES COME FROM ────────────────────────────────────────────────
// The landing site's pricing copy: `lp.pricing.plansOwner` and
// `lp.pricing.plansBuilder` in marketing-site/src/messages/*.json, positionally
// keyed by OWNER_PLAN_KEYS / BUILDER_PLAN_KEYS in SectionPricing.tsx. Verbatim,
// in English, because the portal is English-only today while the landing site is
// localised — a Portuguese visitor who bought "Construtor Independente" sees
// "Independent Builder" here, which is a known and accepted mismatch until the
// portal grows i18n. Paraphrasing them would be worse: the owner has to be able
// to match what this screen calls their plan to what they clicked on to buy it.

/**
 * Plan key → the name printed on the card that sold it.
 *
 * Keys are `PLAN_KEYS` from services/identity/plans.mjs. `free_founding` has no
 * card — it is claimed through the owner ribbon CTA (LINA-180) — so its name is
 * the one the landing page and the no-access screen both use for it.
 */
const PLAN_LABEL: Readonly<Record<string, string>> = Object.freeze({
  free_founding: 'Founding seat',
  // Owner plans (lp.pricing.plansOwner).
  personal: 'Personal',
  build_plus: 'Build+',
  real_estate_investor: 'Real Estate Investor',
  // Builder plans (lp.pricing.plansBuilder).
  independent_builder: 'Independent Builder',
  growing_builder: 'Growing Builder',
  construction_business: 'Construction Business',
});

/**
 * The name to print for a plan key, or `null` when we do not have one.
 *
 * `null` is a real answer and callers must render it as one. It happens for the
 * hand-granted `beta` and `invite` seats, which carry no plan at all and are
 * capped at the entry allowance by `DEFAULT_ACTIVE_PROJECT_LIMIT` — those people
 * hold a genuine seat and naming their plan "Unknown" would read as a fault in
 * their account rather than the absence of a purchase.
 */
export function planLabel(plan: string | null | undefined): string | null {
  if (typeof plan !== 'string') return null;
  return Object.hasOwn(PLAN_LABEL, plan) ? PLAN_LABEL[plan] : null;
}

/**
 * The landing site's pricing section — where a bigger plan is chosen.
 *
 * Same env var and same default as the no-access screen (LINA-124), so a preview
 * deployment points at its own landing build rather than production.
 */
export const PRICING_URL = `${(process.env.NEXT_PUBLIC_LANDING_URL || 'https://linknms.com').replace(/\/$/, '')}/#pricing`;
