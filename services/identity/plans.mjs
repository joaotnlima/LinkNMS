// Plan entitlements — how many builds a seat may RUN (LINA-189, ADR-0013).
//
// ── THE THIRD LEG OF ADR-0008 ────────────────────────────────────────────────
// ADR-0008 split access into three questions that must never be conflated:
//
//   authentication  who are you            → Clerk
//   entitlement     what did you buy       → identity.seat
//   authorization   what may you do HERE   → identity.membership + authz.mjs
//
// The seat already answered "may this address come in at all". It did not answer
// "how many builds may this address run", and the landing page has been selling
// exactly that answer since LINA-173: every plan card prints an active-project
// allowance ("1 active project", "Up to 3 active projects", "Unlimited"). Until
// now nothing on the write path had ever read it, so every plan was unlimited.
//
// ── WHY THE NUMBERS LIVE IN CODE AND THE PLAN LIVES IN THE DATABASE ──────────
// `identity.seat.plan` records WHAT WAS BOUGHT — a fact about a commercial
// agreement, immutable history, and the only thing a migration should ever have
// to carry. This table records WHAT THAT BUYS, which is a pricing decision the
// founder changes without anybody's data changing. Storing the limit on the row
// would freeze every existing customer at the allowance that was current the day
// they signed up, and re-pricing would become a data migration.
//
// ── WHY 'MANAGING', NOT 'MEMBER OF' ──────────────────────────────────────────
// The pricing page is explicit: "A project counts towards your plan when your
// organisation is the Managing Organisation. Collaborators are always free."
// So the cap counts builds this party OWNS, and an invited counterparty — a sub,
// an inspector, an architect on somebody else's record — consumes nothing. That
// is deliberate and load-bearing for the product: charging the people you invite
// is exactly what stops a shared record from being shared.

/** Every plan key the landing funnel can record on a seat (marketing lib/db PLAN_KEYS). */
export const PLAN_KEYS = Object.freeze([
  'free_founding',
  'personal',
  'build_plus',
  'real_estate_investor',
  'independent_builder',
  'growing_builder',
  'construction_business',
]);

// `null` means unlimited — deliberately not Infinity, so the value survives JSON
// and a missing entry can never be mistaken for "no limit".
const ACTIVE_PROJECT_LIMIT = Object.freeze({
  // The founding 50. Not a paid plan; it is the entry allowance, which is the
  // owner's first build — the same thing `personal` grants.
  free_founding: 1,
  // Owner plans (lp.pricing.plansOwner).
  personal: 1,
  build_plus: 10,
  real_estate_investor: null,
  // Builder plans (lp.pricing.plansBuilder).
  independent_builder: 3,
  growing_builder: 10,
  construction_business: null,
});

// A seat with no plan: the hand-granted 'beta' seats and every 'invite' seat.
// One build, matching the entry allowance.
//
// This is the FAIL-CLOSED default on purpose. An unrecognised or absent plan
// means we do not know what this person paid for, and the safe answer to that on
// a metered resource is the smallest allowance, not the largest — the failure
// mode of guessing high is giving away the product, and it is silent. An invited
// counterparty is unaffected either way, because invitations do not count.
export const DEFAULT_ACTIVE_PROJECT_LIMIT = 1;

/**
 * How many builds a seat on this plan may run at once.
 * @param {unknown} plan a plan key, or null/unknown for a seat that carries none
 * @returns {number|null} the allowance, or null for unlimited
 */
export function activeProjectLimit(plan) {
  if (typeof plan !== 'string' || !Object.hasOwn(ACTIVE_PROJECT_LIMIT, plan)) {
    return DEFAULT_ACTIVE_PROJECT_LIMIT;
  }
  return ACTIVE_PROJECT_LIMIT[plan];
}

/** Is this a plan key the funnel is allowed to record? */
export function isPlanKey(value) {
  return typeof value === 'string' && PLAN_KEYS.includes(value);
}
