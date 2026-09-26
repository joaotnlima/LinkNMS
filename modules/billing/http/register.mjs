// Billing module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// Phase 8 surface: the whole Billing tag — plan catalogue, one subscription
// per org, usage vs entitlements, add-ons, and the (unregistered) provider
// webhook. The entitlements PORT other modules consume is
// application/entitled.mjs, not a route.
import {
  listPlans, subscribe, changeSubscription, cancelSubscription,
  getUsage, buyAddOn, billingWebhook,
} from '../application/use-cases.mjs';

/**
 * @param {{ store: object }} deps
 */
export function registerBilling(router, { store }) {
  router.register('GET', '/billing/plans', 'listPlans', ({ viewer, query }) =>
    listPlans({ viewer, store, query }));

  router.register('POST', '/billing/subscriptions', 'subscribe', ({ viewer, body, headers }) =>
    subscribe({ viewer, store, body, idempotencyKey: headers['idempotency-key'] }));

  router.register('PATCH', '/billing/subscriptions/{subscriptionId}', 'changeSubscription', ({ viewer, params, body }) =>
    changeSubscription({ viewer, store, subscriptionId: params.subscriptionId, body }));

  router.register('POST', '/billing/subscriptions/{subscriptionId}:cancel', 'cancelSubscription', ({ viewer, params }) =>
    cancelSubscription({ viewer, store, subscriptionId: params.subscriptionId }));

  router.register('GET', '/billing/usage', 'getUsage', ({ viewer }) =>
    getUsage({ viewer, store }));

  router.register('POST', '/billing/add-ons', 'buyAddOn', ({ viewer, body, headers }) =>
    buyAddOn({ viewer, store, body, idempotencyKey: headers['idempotency-key'] }));

  // 404 for every provider — none is registered (open question 17).
  router.register('POST', '/billing/webhooks/{provider}', 'billingWebhook', ({ params }) =>
    billingWebhook({ params }));
}
