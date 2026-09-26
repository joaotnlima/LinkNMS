// The entitlements PORT — the point of phase 8 (AGENT-INDEX §5 row 8).
//
// Other modules (and the doc-16 access rule `allow = permission ∧
// relationship ∧ staffing ∧ entitlement`) ask ONE question here:
//
//     entitled(orgId, key, { projectId }) → { allowed, limit, used }
//
// Semantics (docs 04 §4, 07):
//   - Keys are CREATE/MANAGE capabilities only (GATED_KEYS in domain/model).
//     Any other key — reads, the record, anything already agreed to — is
//     allowed unconditionally, subscription or not. That is the phase-8
//     invariant: "reads of signed contracts never blocked".
//   - live subscription (trialing/active): allowed while used < limit, where
//     limit = plan entitlement + add-on top-ups ('rfp:open-credits').
//   - lapsed (past_due/canceled/none): gated keys deny — UNLESS a live
//     sponsorship covers the org on a contract of `projectId` (D-05
//     mitigation: the sponsor pays, the supplier works).
//
// The provider behind subscriptions is deliberately absent (open question
// 17); this port only reads what the store answers, so a Clerk-Billing or
// Stripe adapter can land later without touching a single caller.
import { ADD_ON_KEY, GATED_KEYS, decideEntitlement } from '../domain/model.mjs';

export { GATED_KEYS };

/** @param {ReturnType<import('../infra/pg-store.mjs').createBillingStore>} store */
export function createEntitlements(store) {
  return {
    /**
     * @param {string} orgId
     * @param {string} key
     * @param {{ projectId?: string|null }} [context]
     * @returns {Promise<{ allowed: boolean, limit: number|null, used: number }>}
     */
    async entitled(orgId, key, { projectId = null } = {}) {
      // Non-gated key: answered before any I/O — a database outage can slow
      // a read down, but a billing lookup can never block one.
      if (!GATED_KEYS.includes(key)) return decideEntitlement({ key, subscription: null, planEntitlements: null });

      const subscription = await store.getSubscriptionByOrg(orgId);
      const plan = subscription ? await store.getPlan(subscription.plan_code) : null;
      const addOnKind = Object.entries(ADD_ON_KEY).find(([, k]) => k === key)?.[0] ?? null;
      const addOnQuantity = addOnKind ? await store.addOnQuantity(orgId, addOnKind) : 0;
      const usage = await store.usage(orgId);
      const sponsored = projectId != null && (await store.sponsorshipCovers(orgId, projectId));

      return decideEntitlement({
        key,
        subscription,
        planEntitlements: plan?.entitlements ?? null,
        addOnQuantity,
        used: usage[key] ?? 0,
        sponsored,
      });
    },
  };
}
