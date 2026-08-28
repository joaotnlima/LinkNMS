// Container wiring tests (LINA-56 mount + LINA-58 analytics injection).
//
// These assert the SHAPE of the deployed composition without a database: pg
// pools connect lazily, so a container can be built against dummy URLs and
// inspected. What is proven here is the set of things that break silently:
//
//   * one pool PER SERVICE ROLE — sharing a pool would quietly hand every
//     service the same Postgres role and dissolve the least-privilege split the
//     ledger's write guard depends on (ADR-0006 §1);
//   * a missing connection string fails at CONSTRUCTION, not at the first
//     request that happens to touch that service;
//   * the analytics passed in is the one the container holds — the injection
//     that turns the LINA-55 instrumentation from a no-op into delivered events.
//     That it reaches every service is proven by composition.test.mjs, which
//     exercises the same createServices() this container calls.
//
// Run: node --test services/gateway/container.test.mjs
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createContainer } from './container.mjs';

const URLS = {
  identity: 'postgres://identity_app@localhost:5432/linknms?sslmode=disable',
  decision: 'postgres://decision_app@localhost:5432/linknms?sslmode=disable',
  changeOrder: 'postgres://change_order_app@localhost:5432/linknms?sslmode=disable',
  ledger: 'postgres://ledger_app@localhost:5432/linknms?sslmode=disable',
};

const noopAnalytics = () => ({ capture() {}, async flush() {} });

describe('createContainer', () => {
  test('gives every service its own pool, and exposes the full HTTP surface', async () => {
    const container = createContainer({ urls: URLS, analytics: noopAnalytics() });
    try {
      const pools = Object.values(container.pools);
      assert.equal(pools.length, 4);
      assert.equal(new Set(pools).size, 4, 'one pool per service role, never shared');

      for (const name of ['identity', 'decision', 'changeOrder', 'ledger']) {
        assert.ok(container.http[name], `route layer needs container.http.${name}`);
      }
      for (const name of ['identity', 'decision', 'changeOrder']) {
        assert.ok(container.services[name], `container.services.${name} must be composed`);
      }
    } finally {
      await container.close();
    }
  });

  test('holds the analytics it was given, for the route layer to flush', async () => {
    const analytics = noopAnalytics();
    const container = createContainer({ urls: URLS, analytics });
    try {
      assert.equal(container.analytics, analytics);
    } finally {
      await container.close();
    }
  });

  test('a missing connection string fails loudly at construction', () => {
    const saved = { ...process.env };
    for (const key of [
      'DATABASE_URL', 'IDENTITY_DATABASE_URL', 'DECISION_DATABASE_URL',
      'CHANGE_ORDER_DATABASE_URL', 'LEDGER_DATABASE_URL',
    ]) delete process.env[key];
    try {
      assert.throws(() => createContainer({ analytics: noopAnalytics() }), /DATABASE_URL/);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  test('close() releases every pool', async () => {
    const container = createContainer({ urls: URLS, analytics: noopAnalytics() });
    await container.close();
    for (const pool of Object.values(container.pools)) {
      assert.equal(pool.ended, true, 'a leaked pool holds serverless connections open');
    }
  });
});
