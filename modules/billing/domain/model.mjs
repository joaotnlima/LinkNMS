// Billing domain — pure logic, no I/O (doc 02 layout; docs 04 §4, 07, 15).
//
// Two things live here: the wire projections (Plan / Subscription per the
// contract schemas — money is a Money object, cents + EUR) and the ONE
// entitlement decision, `decideEntitlement`, which the application port
// (application/entitled.mjs) feeds with rows the store loaded.

export const SUBSCRIPTION_STATUSES = Object.freeze(['trialing', 'active', 'past_due', 'canceled']);
/** A subscription that occupies the org's one slot (doc 15: org_id UNIQUE). */
export const LIVE_STATUSES = Object.freeze(['trialing', 'active']);
/** Still occupies the slot but no longer answers entitlements (doc 07: lapsed). */
export const BLOCKING_STATUSES = Object.freeze(['trialing', 'active', 'past_due']);

export const PLAN_INTERVALS = Object.freeze(['month', 'year', 'project']);
export const ADD_ON_KINDS = Object.freeze(['open_rfp_credits', 'promotion']);

/**
 * The capability keys entitlements GATE — creating and managing only.
 *
 * This list is the explicit guard for the phase-8 invariant (AGENT-INDEX §5
 * row 8, doc 04 §4, doc 07): "reading signed contracts and their record is
 * never blocked". READ is not a capability key; any key outside this
 * vocabulary — reads, record access, anything a lapsed org already agreed
 * to — is answered `allowed` without ever consulting the subscription.
 */
export const GATED_KEYS = Object.freeze(['projects:active', 'seats', 'rfp:open-credits']);

/** The add-on kind that tops up a gated key's limit (doc 07: add-ons). */
export const ADD_ON_KEY = Object.freeze({ open_rfp_credits: 'rfp:open-credits' });

/**
 * The entitlement decision (doc 04 §4, doc 07 "Lapsed subscription").
 *
 * @param {{
 *   key: string,
 *   subscription: { status: string }|null,
 *   planEntitlements: Record<string, number>|null,  // the subscription's plan
 *   addOnQuantity?: number,                          // extra limit for this key
 *   used?: number,
 *   sponsored?: boolean,  // a live sponsorship covers this (projectId given)
 * }} input
 * @returns {{ allowed: boolean, limit: number|null, used: number }}
 */
export function decideEntitlement({ key, subscription, planEntitlements, addOnQuantity = 0, used = 0, sponsored = false }) {
  // Doc 04 §4: entitlements gate *creating* and *managing*, never *seeing
  // what you already agreed to*. A key outside the gated vocabulary is a
  // read (or an ungated capability) and is allowed unconditionally — even
  // with a canceled subscription, even with none at all.
  if (!GATED_KEYS.includes(key)) return { allowed: true, limit: null, used: 0 };

  const live = subscription != null && LIVE_STATUSES.includes(subscription.status);
  if (!live) {
    // Doc 04 §4 Sponsorship: a live sponsorship on a contract of this project
    // covers the supplier's project-scoped entitlements (D-05 mitigation).
    if (sponsored) return { allowed: true, limit: null, used };
    return { allowed: false, limit: null, used };
  }

  const base = planEntitlements?.[key];
  if (base === undefined) {
    // The plan does not meter this capability — unmetered, not forbidden.
    // (Every gated key a plan intends to cap is listed in its entitlements;
    // forbidding on absence would brick a capability the catalogue simply
    // never priced.)
    return { allowed: true, limit: null, used };
  }
  const limit = Number(base) + Number(addOnQuantity || 0);
  return { allowed: used < limit, limit, used };
}

// ── wire projections (contract schemas Plan / Subscription) ──────────────

/** Plan schema: price is Money (cents, EUR — the schema's only currency). */
export function planBody(row) {
  return {
    code: row.code,
    org_kind: row.org_kind,
    name: row.name,
    price: { amount_cents: Number(row.price_cents), currency: 'EUR' },
    interval: row.interval,
    entitlements: row.entitlements ?? {},
  };
}

/** Subscription schema — snake_case keys, ISO period end (null: interval 'project' / open). */
export function subscriptionBody(row) {
  return {
    id: row.id,
    org_id: row.org_id,
    plan_code: row.plan_code,
    status: row.status,
    current_period_end: row.current_period_end == null
      ? null
      : new Date(row.current_period_end).toISOString(),
  };
}
