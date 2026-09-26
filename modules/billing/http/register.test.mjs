// Billing operations end to end through the /api/v2 router, DB-free: the
// fake store answers what pg-store would. Proves the doc-16 request flow —
// session → active org → `org:billing:manage` (403 reason 'role') — the
// x-human-only refusal on subscribe/changeSubscription (doc 19), one
// subscription per org (409, canceled slot replaceable), the 422 plan/org-kind
// rule, existence hiding on foreign subscription ids, the idempotent cancel,
// the Plan-schema-as-add-on interpretation of buyAddOn (402 without a live
// subscription), and the always-404 provider webhook (open question 17).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerBilling } from './register.mjs';

const GC_ORG = '01920000-0000-7000-8000-0000000000a1';
const HOUSEHOLD_ORG = '01920000-0000-7000-8000-0000000000a2';
const OTHER_ORG = '01920000-0000-7000-8000-0000000000a9';
const SUB_ID = '01920000-0000-7000-8000-0000000000b1';
const FOREIGN_SUB = '01920000-0000-7000-8000-0000000000b2';
const ME = '01920000-0000-7000-8000-0000000000e9';

const PLANS = [
  { code: 'gc-pro', org_kind: 'contractor', name: 'GC Pro', price_cents: 14900, interval: 'month', entitlements: { 'projects:active': 10, seats: 15, 'rfp:open-credits': 10 } },
  { code: 'gc-starter', org_kind: 'contractor', name: 'GC Starter', price_cents: 4900, interval: 'month', entitlements: { 'projects:active': 3, seats: 5, 'rfp:open-credits': 3 } },
  { code: 'owner-project', org_kind: 'household', name: 'Owner — per project', price_cents: 14900, interval: 'project', entitlements: { 'projects:active': 1, seats: 5 } },
];

function fakeStore({ subscription = null } = {}) {
  const subs = new Map();
  if (subscription) subs.set(subscription.id, subscription);
  const addOns = [];
  const events = [];

  return {
    subs, addOns, events,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME } : null; },
    async getPlan(code) { return PLANS.find((p) => p.code === code) ?? null; },
    async listPlans({ orgKind, cursor, limit }) {
      const all = PLANS.filter((p) => p.org_kind === orgKind)
        .sort((a, b) => (a.code < b.code ? -1 : 1))
        .filter((p) => !cursor || p.code > cursor);
      const items = all.slice(0, limit);
      return { items, nextCursor: all.length > limit ? items[items.length - 1].code : null };
    },
    async getSubscription(id) { return subs.get(id) ?? null; },
    async getSubscriptionByOrg(orgId) {
      return [...subs.values()].find((s) => s.org_id === orgId) ?? null;
    },
    async addOnQuantity(orgId, kind) {
      return addOns.filter((a) => a.orgId === orgId && a.kind === kind)
        .reduce((n, a) => n + a.quantity, 0);
    },
    async sponsorshipCovers() { return false; },
    async usage() { return { 'projects:active': 2, seats: 4, 'rfp:open-credits': 1 }; },
    async subscribe({ id, orgId, planCode, interval }) {
      const existing = await this.getSubscriptionByOrg(orgId);
      const row = {
        id: existing?.id ?? id, org_id: orgId, plan_code: planCode, status: 'active',
        current_period_end: interval === 'project' ? null : '2026-10-26T00:00:00Z',
        provider_ref: null,
      };
      subs.set(row.id, row);
      events.push('billing.subscription.changed');
      return row;
    },
    async changePlan({ subscriptionId, planCode }) {
      const row = { ...subs.get(subscriptionId), plan_code: planCode };
      subs.set(subscriptionId, row);
      events.push('billing.subscription.changed');
      return row;
    },
    async cancel({ subscriptionId }) {
      const row = { ...subs.get(subscriptionId), status: 'canceled' };
      subs.set(subscriptionId, row);
      events.push('billing.subscription.changed');
      return row;
    },
    async addAddOn({ id, orgId, kind, quantity }) {
      const row = { id, orgId, kind, quantity, period: '2026-09' };
      addOns.push(row);
      return row;
    },
    async idempotent(meta, fn) { return fn(); },
  };
}

function viewer({ orgId = GC_ORG, orgKind = 'contractor', permissions = ['org:billing:manage'], channel = 'ui' } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: orgId && `clerk_${orgId}`,
    orgKind: orgId ? orgKind : null, orgRole: orgId ? 'admin' : null, permissions, channel,
  });
}

const liveSub = (over = {}) => ({
  id: SUB_ID, org_id: GC_ORG, plan_code: 'gc-starter', status: 'active',
  current_period_end: '2026-10-01T00:00:00Z', provider_ref: null, ...over,
});

describe('billing over the /api/v2 router', () => {
  let router, store;

  const mount = (opts) => {
    router = createRouter();
    store = fakeStore(opts);
    registerBilling(router, { store });
  };
  const dispatch = (method, path, viewerCtx, body = null, headers = {}) =>
    router.dispatch({ method, path, viewer: viewerCtx, body, query: {}, headers });

  beforeEach(() => mount());

  describe('listPlans', () => {
    test('answers only the viewer org kind, as Plan bodies with Money', async () => {
      const res = await dispatch('GET', '/billing/plans', viewer({ permissions: [] }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.items.map((p) => p.code), ['gc-pro', 'gc-starter']);
      assert.deepEqual(res.body.items[0].price, { amount_cents: 14900, currency: 'EUR' });
      assert.equal(res.body.next_cursor, null);
    });

    test('a household sees the household catalogue', async () => {
      const res = await dispatch('GET', '/billing/plans', viewer({ orgId: HOUSEHOLD_ORG, orgKind: 'household', permissions: [] }));
      assert.deepEqual(res.body.items.map((p) => p.code), ['owner-project']);
    });

    test('needs an active org', async () => {
      const res = await dispatch('GET', '/billing/plans', viewer({ orgId: null }));
      assert.equal(res.status, 403);
      assert.equal(res.body.reason, 'no_active_org');
    });
  });

  describe('subscribe', () => {
    test('403 reason role without org:billing:manage', async () => {
      const res = await dispatch('POST', '/billing/subscriptions', viewer({ permissions: [] }), { plan_code: 'gc-pro' });
      assert.equal(res.status, 403);
      assert.equal(res.body.reason, 'role');
    });

    test('x-human-only: the MCP channel is refused before anything else', async () => {
      const res = await dispatch('POST', '/billing/subscriptions', viewer({ channel: 'mcp' }), { plan_code: 'gc-pro' });
      assert.equal(res.status, 403);
      assert.equal(res.body.reason, 'human_only');
    });

    test("422 when the plan is another org kind's", async () => {
      const res = await dispatch('POST', '/billing/subscriptions', viewer(), { plan_code: 'owner-project' });
      assert.equal(res.status, 422);
      assert.equal(res.body.code, 'validation_failed');
    });

    test('422 when the plan does not exist', async () => {
      const res = await dispatch('POST', '/billing/subscriptions', viewer(), { plan_code: 'gc-imaginary' });
      assert.equal(res.status, 422);
    });

    test('201: active, period end set, Subscription shape, event published', async () => {
      const res = await dispatch('POST', '/billing/subscriptions', viewer(), { plan_code: 'gc-pro' });
      assert.equal(res.status, 201);
      assert.equal(res.body.org_id, GC_ORG);
      assert.equal(res.body.plan_code, 'gc-pro');
      assert.equal(res.body.status, 'active');
      assert.ok(res.body.current_period_end);
      assert.deepEqual(store.events, ['billing.subscription.changed']);
    });

    test("interval 'project' has no period end", async () => {
      const res = await dispatch('POST', '/billing/subscriptions', viewer({ orgId: HOUSEHOLD_ORG, orgKind: 'household' }), { plan_code: 'owner-project' });
      assert.equal(res.status, 201);
      assert.equal(res.body.current_period_end, null);
    });

    test('409 while a live subscription exists (one per org)', async () => {
      mount({ subscription: liveSub() });
      const res = await dispatch('POST', '/billing/subscriptions', viewer(), { plan_code: 'gc-pro' });
      assert.equal(res.status, 409);
    });

    test('a past_due subscription also blocks (it still holds the slot)', async () => {
      mount({ subscription: liveSub({ status: 'past_due' }) });
      const res = await dispatch('POST', '/billing/subscriptions', viewer(), { plan_code: 'gc-pro' });
      assert.equal(res.status, 409);
    });

    test('a canceled subscription is replaced in place (org_id UNIQUE)', async () => {
      mount({ subscription: liveSub({ status: 'canceled' }) });
      const res = await dispatch('POST', '/billing/subscriptions', viewer(), { plan_code: 'gc-pro' });
      assert.equal(res.status, 201);
      assert.equal(res.body.id, SUB_ID);
      assert.equal(res.body.status, 'active');
    });
  });

  describe('changeSubscription', () => {
    beforeEach(() => mount({ subscription: liveSub() }));

    test('x-human-only over MCP → 403 human_only', async () => {
      const res = await dispatch('PATCH', `/billing/subscriptions/${SUB_ID}`, viewer({ channel: 'mcp' }), { plan_code: 'gc-pro' });
      assert.equal(res.status, 403);
      assert.equal(res.body.reason, 'human_only');
    });

    test("404 for a subscription that is not the caller org's (existence hiding)", async () => {
      store.subs.set(FOREIGN_SUB, liveSub({ id: FOREIGN_SUB, org_id: OTHER_ORG }));
      const res = await dispatch('PATCH', `/billing/subscriptions/${FOREIGN_SUB}`, viewer(), { plan_code: 'gc-pro' });
      assert.equal(res.status, 404);
    });

    test('200: only plan_code changes; status and period end stay', async () => {
      const res = await dispatch('PATCH', `/billing/subscriptions/${SUB_ID}`, viewer(),
        { plan_code: 'gc-pro', status: 'trialing', current_period_end: '2030-01-01T00:00:00Z' });
      assert.equal(res.status, 200);
      assert.equal(res.body.plan_code, 'gc-pro');
      assert.equal(res.body.status, 'active');
      assert.equal(res.body.current_period_end, new Date('2026-10-01T00:00:00Z').toISOString());
    });

    test('422 on a plan for another org kind', async () => {
      const res = await dispatch('PATCH', `/billing/subscriptions/${SUB_ID}`, viewer(), { plan_code: 'owner-project' });
      assert.equal(res.status, 422);
    });

    test('409 changing a canceled subscription', async () => {
      mount({ subscription: liveSub({ status: 'canceled' }) });
      const res = await dispatch('PATCH', `/billing/subscriptions/${SUB_ID}`, viewer(), { plan_code: 'gc-pro' });
      assert.equal(res.status, 409);
    });
  });

  describe('cancelSubscription', () => {
    beforeEach(() => mount({ subscription: liveSub() }));

    test('200 → canceled, event published', async () => {
      const res = await dispatch('POST', `/billing/subscriptions/${SUB_ID}:cancel`, viewer());
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'canceled');
      assert.deepEqual(store.events, ['billing.subscription.changed']);
    });

    test('idempotent: canceling a canceled subscription replays 200, no new event', async () => {
      await dispatch('POST', `/billing/subscriptions/${SUB_ID}:cancel`, viewer());
      const res = await dispatch('POST', `/billing/subscriptions/${SUB_ID}:cancel`, viewer());
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'canceled');
      assert.equal(store.events.length, 1);
    });

    test('404 on a foreign subscription id', async () => {
      store.subs.set(FOREIGN_SUB, liveSub({ id: FOREIGN_SUB, org_id: OTHER_ORG }));
      const res = await dispatch('POST', `/billing/subscriptions/${FOREIGN_SUB}:cancel`, viewer());
      assert.equal(res.status, 404);
    });
  });

  describe('getUsage', () => {
    test('limit (plan + add-ons) and used per metered key', async () => {
      mount({ subscription: liveSub() });
      store.addOns.push({ orgId: GC_ORG, kind: 'open_rfp_credits', quantity: 5 });
      const res = await dispatch('GET', '/billing/usage', viewer());
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        entitlements: {
          'projects:active': { limit: 3, used: 2 },
          seats: { limit: 5, used: 4 },
          'rfp:open-credits': { limit: 8, used: 1 },
        },
      });
    });

    test('no subscription → empty entitlements', async () => {
      const res = await dispatch('GET', '/billing/usage', viewer());
      assert.deepEqual(res.body, { entitlements: {} });
    });

    test('403 role without org:billing:manage', async () => {
      const res = await dispatch('GET', '/billing/usage', viewer({ permissions: [] }));
      assert.equal(res.status, 403);
    });
  });

  describe('buyAddOn (body = Plan schema; code names the add-on kind)', () => {
    test('402 not_entitled without a live subscription', async () => {
      const res = await dispatch('POST', '/billing/add-ons', viewer(), { code: 'open_rfp_credits' });
      assert.equal(res.status, 402);
      assert.equal(res.body.code, 'not_entitled');
    });

    test('422 on an unknown add-on kind', async () => {
      mount({ subscription: liveSub() });
      const res = await dispatch('POST', '/billing/add-ons', viewer(), { code: 'gold-stars' });
      assert.equal(res.status, 422);
    });

    test("201: inserts the add-on (quantity from entitlements, default 1) and answers the org's Subscription", async () => {
      mount({ subscription: liveSub() });
      const res = await dispatch('POST', '/billing/add-ons', viewer(), { code: 'open_rfp_credits', entitlements: { quantity: 5 } });
      assert.equal(res.status, 201);
      assert.equal(res.body.id, SUB_ID);
      assert.deepEqual(store.addOns.map(({ kind, quantity }) => ({ kind, quantity })), [{ kind: 'open_rfp_credits', quantity: 5 }]);

      const one = await dispatch('POST', '/billing/add-ons', viewer(), { code: 'promotion' });
      assert.equal(one.status, 201);
      assert.equal(store.addOns[1].quantity, 1);
    });
  });

  describe('billingWebhook — no provider is registered (open question 17)', () => {
    test('404 for any provider name', async () => {
      for (const provider of ['stripe', 'clerk', 'anything']) {
        const res = await dispatch('POST', `/billing/webhooks/${provider}`, viewer({ permissions: [] }), { anything: true });
        assert.equal(res.status, 404);
        assert.equal(res.body.code, 'not_found');
      }
    });
  });
});
