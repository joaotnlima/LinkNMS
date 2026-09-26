// The entitlement decision, pure (phase 8 acceptance, AGENT-INDEX §5:
// "Reads of signed contracts never blocked by entitlements").
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideEntitlement, GATED_KEYS, planBody, subscriptionBody,
} from './model.mjs';

describe('decideEntitlement — the reads-never-blocked invariant', () => {
  test('a key outside GATED_KEYS is allowed even on a CANCELED subscription', () => {
    // Doc 04 §4 / doc 07: a lapsed org still reads its signed contracts and
    // their record — READ is not an entitlement key at all.
    const res = decideEntitlement({
      key: 'contract:read',
      subscription: { status: 'canceled' },
      planEntitlements: null,
    });
    assert.deepEqual(res, { allowed: true, limit: null, used: 0 });
  });

  test('a key outside GATED_KEYS is allowed with NO subscription', () => {
    const res = decideEntitlement({ key: 'record:read', subscription: null, planEntitlements: null });
    assert.deepEqual(res, { allowed: true, limit: null, used: 0 });
  });

  test('the same canceled subscription answers false for a gated key', () => {
    const res = decideEntitlement({
      key: 'projects:active',
      subscription: { status: 'canceled' },
      planEntitlements: { 'projects:active': 10 },
      used: 1,
    });
    assert.deepEqual(res, { allowed: false, limit: null, used: 1 });
  });

  test('GATED_KEYS is frozen and contains only create/manage capabilities', () => {
    assert.ok(Object.isFrozen(GATED_KEYS));
    assert.deepEqual([...GATED_KEYS], ['projects:active', 'seats', 'rfp:open-credits']);
  });
});

describe('decideEntitlement — live subscriptions', () => {
  const sub = { status: 'active' };
  const ent = { 'projects:active': 3, seats: 5, 'rfp:open-credits': 2 };

  test('used < limit → allowed, with the numbers', () => {
    assert.deepEqual(
      decideEntitlement({ key: 'projects:active', subscription: sub, planEntitlements: ent, used: 2 }),
      { allowed: true, limit: 3, used: 2 },
    );
  });

  test('used = limit → not allowed', () => {
    assert.deepEqual(
      decideEntitlement({ key: 'seats', subscription: sub, planEntitlements: ent, used: 5 }),
      { allowed: false, limit: 5, used: 5 },
    );
  });

  test('trialing counts as live', () => {
    assert.equal(
      decideEntitlement({ key: 'seats', subscription: { status: 'trialing' }, planEntitlements: ent, used: 0 }).allowed,
      true,
    );
  });

  test('past_due is NOT live — gated keys deny', () => {
    assert.equal(
      decideEntitlement({ key: 'seats', subscription: { status: 'past_due' }, planEntitlements: ent, used: 0 }).allowed,
      false,
    );
  });

  test('add-on quantity tops up the plan limit', () => {
    assert.deepEqual(
      decideEntitlement({ key: 'rfp:open-credits', subscription: sub, planEntitlements: ent, addOnQuantity: 5, used: 6 }),
      { allowed: true, limit: 7, used: 6 },
    );
  });

  test('a gated key the plan does not meter is unmetered, not forbidden', () => {
    assert.deepEqual(
      decideEntitlement({ key: 'rfp:open-credits', subscription: sub, planEntitlements: { seats: 5 }, used: 4 }),
      { allowed: true, limit: null, used: 4 },
    );
  });
});

describe('decideEntitlement — sponsorship (doc 04 §4, D-05 mitigation)', () => {
  test('no subscription but a live sponsorship on the project → allowed', () => {
    assert.deepEqual(
      decideEntitlement({ key: 'projects:active', subscription: null, planEntitlements: null, sponsored: true, used: 1 }),
      { allowed: true, limit: null, used: 1 },
    );
  });

  test('canceled subscription + sponsorship → still allowed (coverage wins)', () => {
    assert.equal(
      decideEntitlement({
        key: 'seats', subscription: { status: 'canceled' }, planEntitlements: { seats: 1 }, sponsored: true, used: 3,
      }).allowed,
      true,
    );
  });
});

describe('wire projections', () => {
  test('planBody — Money object in cents, EUR', () => {
    assert.deepEqual(
      planBody({ code: 'gc-pro', org_kind: 'contractor', name: 'GC Pro', price_cents: '14900', interval: 'month', entitlements: { seats: 15 } }),
      { code: 'gc-pro', org_kind: 'contractor', name: 'GC Pro', price: { amount_cents: 14900, currency: 'EUR' }, interval: 'month', entitlements: { seats: 15 } },
    );
  });

  test('subscriptionBody — snake_case, ISO period end, null stays null', () => {
    const id = '01920000-0000-7000-8000-000000000001';
    const org = '01920000-0000-7000-8000-000000000002';
    assert.deepEqual(
      subscriptionBody({ id, org_id: org, plan_code: 'owner-project', status: 'active', current_period_end: null }),
      { id, org_id: org, plan_code: 'owner-project', status: 'active', current_period_end: null },
    );
    assert.equal(
      subscriptionBody({ id, org_id: org, plan_code: 'gc-pro', status: 'active', current_period_end: '2026-10-01T00:00:00Z' }).current_period_end,
      '2026-10-01T00:00:00.000Z',
    );
  });
});
