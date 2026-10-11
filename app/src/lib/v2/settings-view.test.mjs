// Unit tests for the /settings view model (PRD-12 N-8..N-10).
// Run: node --test src/lib/v2/settings-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  can, entitlementRows, planPriceLabel, roleLabel, subscriptionActions,
} from './settings-view.ts';

test('permissions come from the server-resolved list only', () => {
  assert.equal(can({ permissions: ['org:members:manage'] }, 'org:members:manage'), true);
  assert.equal(can({ permissions: [] }, 'org:members:manage'), false);
  assert.equal(can(null, 'org:billing:manage'), false);
});

test('entitlement rows: stable order, labels, full flag', () => {
  const rows = entitlementRows({ entitlements: { seats: { limit: 5, used: 5 }, 'projects:active': { limit: 3, used: 1 } } });
  assert.deepEqual(rows.map((r) => [r.key, r.label, r.full]), [
    ['projects:active', 'Active builds', false], ['seats', 'Seats (members)', true],
  ]);
  assert.deepEqual(entitlementRows(null), []);
});

test('plan price is the API Money formatted, never computed', () => {
  assert.equal(planPriceLabel({ price: { amount_cents: 4900, currency: 'EUR' }, interval: 'month' }), '€49.00 per month');
  assert.equal(planPriceLabel({ price: { amount_cents: 14900, currency: 'EUR' }, interval: 'project' }), '€149.00 per build');
});

test('subscription affordances follow its status', () => {
  assert.deepEqual(subscriptionActions(null), { canChange: false, canCancel: false, canSubscribe: true });
  assert.deepEqual(subscriptionActions({ status: 'active' }), { canChange: true, canCancel: true, canSubscribe: false });
  assert.deepEqual(subscriptionActions({ status: 'past_due' }), { canChange: false, canCancel: true, canSubscribe: false });
  assert.deepEqual(subscriptionActions({ status: 'canceled' }), { canChange: false, canCancel: false, canSubscribe: true });
});

test('role labels', () => {
  assert.equal(roleLabel('site_lead'), 'Site lead');
  assert.equal(roleLabel(null), '');
});
