// Composition-root tests (LINA-58).
//
// LINA-55 proved each service EMITS its events when handed an analytics. This
// suite proves the two things that stand between "emitted" and "landed in
// PostHog", which are exactly the two ways this ships broken:
//
//   1. INJECTION — the services built by the composition root are the ones with
//      analytics wired. Nothing here stubs a service: the identity → invite →
//      join → propose → decide flow runs through `createServices(...)` and the
//      events must appear in the sink. Forget the injection and every service
//      silently falls back to the no-op and this suite goes red.
//   2. FLUSH — the PostHog sink batches; on a serverless runtime an unflushed
//      buffer is a dropped batch. `withAnalyticsFlush` must flush before the
//      response returns, on the error path as well as the happy path, and must
//      never turn a committed domain write into a 500.
//
// Run: node --test services/composition.test.mjs
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createServices,
  withAnalyticsFlush,
  getAnalytics,
  resetAnalyticsForTests,
} from './composition.mjs';

import { createAnalytics, createMemorySink, EVENTS } from './analytics/index.mjs';
import { createMemoryStore as createIdentityStore } from './identity/store.mjs';
import { createMemoryLedger as createIdentityLedger } from './identity/ledger-port.mjs';
import { createInMemoryStore as createChangeOrderStore } from './change_order/ports.mjs';

const HOMEOWNER = 'party-homeowner';
const GC = 'party-gc';
const BASELINE = 450_000_00;
const DELTA = 120_000;

// One ledger serving BOTH consumer shapes — appendEvent/budgetSummary (Identity)
// and append/recordBudgetEvent/currentBudget (Change Order). This mirrors the
// real createPgLedger, whose single object implements all five; composing two
// separate ledgers would be a fiction the deployed target cannot reproduce.
function createCompositionLedger() {
  const identityLedger = createIdentityLedger();
  const budgetEvents = new Map(); // changeOrderId -> deltaCents

  function append(_tx, event) {
    return identityLedger.appendEvent(event);
  }

  function recordBudgetEvent(tx, { projectId, changeOrderId, deltaCents, actorPartyId, occurredAt }) {
    if (budgetEvents.has(changeOrderId)) {
      const err = new Error(`budget_event already exists for ${changeOrderId}`);
      err.constructor = { name: 'LedgerBudgetConflict' };
      throw err;
    }
    budgetEvents.set(changeOrderId, deltaCents);
    append(tx, {
      projectId,
      type: 'budget_event',
      actorPartyId,
      occurredAt,
      payload: { changeOrderId, deltaCents },
    });
    return { changeOrderId, deltaCents };
  }

  function currentBudget(projectId) {
    const summary = identityLedger.budgetSummary(projectId)
      ?? { baselineBudgetCents: 0, currentBudgetCents: 0 };
    return {
      baselineCents: summary.baselineBudgetCents,
      approvedTotalCents: summary.currentBudgetCents - summary.baselineBudgetCents,
      currentCents: summary.currentBudgetCents,
    };
  }

  return {
    appendEvent: identityLedger.appendEvent,
    budgetSummary: identityLedger.budgetSummary,
    append,
    recordBudgetEvent,
    currentBudget,
  };
}

function setup({ analytics } = {}) {
  const sink = createMemorySink();
  const errors = [];
  const built = analytics ?? createAnalytics({
    sink,
    releaseSha: 'abc1234',
    onError: (e) => errors.push(e),
  });
  const ledger = createCompositionLedger();
  const services = createServices({
    ledger,
    identityStore: createIdentityStore({ ledger }),
    changeOrderStore: createChangeOrderStore(),
    analytics: built,
  });
  return { services, sink, errors };
}

// ---------------------------------------------------------------------------
// 1. Injection — the composed services really are instrumented
// ---------------------------------------------------------------------------
describe('composition root: analytics reaches every service', () => {
  test('the full R0 flow through createServices lands all six lifecycle events', async () => {
    const { services, sink, errors } = setup();
    const { identity, changeOrder } = services;

    const project = await identity.createProject({
      actorPartyId: HOMEOWNER, name: 'Maple Street', baselineBudgetCents: BASELINE,
    });
    const { token } = await identity.inviteCounterparty({
      actorPartyId: HOMEOWNER, projectId: project.id,
    });
    await identity.acceptInvitation({ actorPartyId: GC, token });

    const co = await changeOrder.propose(project.id, GC, {
      title: 'Upgrade to oak flooring', costDeltaCents: DELTA,
    });
    await changeOrder.decide(co.id, HOMEOWNER, { decision: 'approve' });

    const seen = sink.captures.map((c) => c.event);
    for (const event of [
      EVENTS.PROJECT_CREATED,
      EVENTS.GC_INVITED,
      EVENTS.GC_JOINED,
      EVENTS.CHANGE_ORDER_RAISED,
      EVENTS.CHANGE_ORDER_DECIDED,
      EVENTS.BUDGET_EVENT_WRITTEN,
    ]) {
      assert.ok(seen.includes(event), `composition must deliver ${event}; got ${seen.join(', ')}`);
    }

    // Every event carries the project group and a server-authenticated actor
    // (§2.1) — the two properties the whole LINA-28 dashboard pivots on.
    for (const capture of sink.captures) {
      assert.equal(capture.groups.project, project.id);
      assert.ok([HOMEOWNER, GC].includes(capture.distinctId));
      assert.equal(capture.properties.actor_party_id, capture.distinctId);
    }

    // The A3 gate, end-to-end through the composed services rather than a unit.
    const decided = sink.captures.find((c) => c.event === EVENTS.CHANGE_ORDER_DECIDED);
    assert.equal(decided.properties.is_self_approval, false);

    assert.deepEqual(errors, [], 'no analytics error should be swallowed on the happy path');
  });

  test('the Change Order service authorizes through the SAME Identity service', async () => {
    const { services } = setup();
    const project = await services.identity.createProject({
      actorPartyId: HOMEOWNER, name: 'Maple Street', baselineBudgetCents: BASELINE,
    });
    // GC has not accepted an invitation, so it is not a member of this project.
    // A second, independently-seeded identity port would wrongly let this through.
    await assert.rejects(
      () => services.changeOrder.propose(project.id, GC, { title: 'x', costDeltaCents: 1 }),
      (err) => err.status === 403 || err.status === 404,
    );
  });

  test('a missing port fails loudly at construction, never at the first request', () => {
    assert.throws(() => createServices({ identityStore: {}, changeOrderStore: {} }), /ledger/);
    assert.throws(() => createServices({ ledger: {}, changeOrderStore: {} }), /identityStore/);
    assert.throws(() => createServices({ ledger: {}, identityStore: {} }), /changeOrderStore/);
  });

  test('decision is absent, not memory-backed, until a decision store exists', () => {
    const { services } = setup();
    assert.equal(services.decision, null,
      'a silent in-memory Decision Log would look wired and lose every decision on cold start');
  });
});

// ---------------------------------------------------------------------------
// 2. Flush — the difference between "emitted" and "delivered"
// ---------------------------------------------------------------------------
describe('withAnalyticsFlush', () => {
  function spyAnalytics({ throws = false } = {}) {
    let flushes = 0;
    return {
      flushes: () => flushes,
      analytics: {
        async flush() {
          flushes += 1;
          if (throws) throw new Error('posthog is down');
        },
      },
    };
  }

  test('flushes exactly once and passes the response through untouched', async () => {
    const spy = spyAnalytics();
    const handler = withAnalyticsFlush(
      async (id) => ({ status: 201, body: { id } }),
      { analytics: spy.analytics },
    );

    assert.deepEqual(await handler('co-1'), { status: 201, body: { id: 'co-1' } });
    assert.equal(spy.flushes(), 1);
  });

  test('flushes on the error path too — failure telemetry is the most valuable kind', async () => {
    const spy = spyAnalytics();
    const boom = new Error('domain exploded');
    const handler = withAnalyticsFlush(async () => { throw boom; }, { analytics: spy.analytics });

    await assert.rejects(() => handler(), (err) => err === boom);
    assert.equal(spy.flushes(), 1, 'a thrown handler must still flush its buffered events');
  });

  test('a flush that throws can never fail a request that otherwise succeeded', async () => {
    const spy = spyAnalytics({ throws: true });
    const handler = withAnalyticsFlush(
      async () => ({ status: 200, body: { ok: true } }),
      { analytics: spy.analytics },
    );

    assert.deepEqual(await handler(), { status: 200, body: { ok: true } });
    assert.equal(spy.flushes(), 1);
  });

  test('a flush that throws does not mask the handler’s own error', async () => {
    const spy = spyAnalytics({ throws: true });
    const boom = new Error('domain exploded');
    const handler = withAnalyticsFlush(async () => { throw boom; }, { analytics: spy.analytics });

    await assert.rejects(() => handler(), (err) => err === boom);
  });

  test('flushes once per request, not once per process', async () => {
    const spy = spyAnalytics();
    const handler = withAnalyticsFlush(async () => 'ok', { analytics: spy.analytics });
    await handler();
    await handler();
    await handler();
    assert.equal(spy.flushes(), 3);
  });

  test('rejects a non-function handler rather than silently passing it through', () => {
    assert.throws(() => withAnalyticsFlush(null, { analytics: spyAnalytics().analytics }));
  });
});

// ---------------------------------------------------------------------------
// 3. The per-process singleton
// ---------------------------------------------------------------------------
describe('getAnalytics', () => {
  test('reads the env once and returns the same instance for every request', () => {
    resetAnalyticsForTests();
    const first = getAnalytics({});
    const second = getAnalytics({ POSTHOG_API_KEY: 'phc_would_be_ignored' });
    assert.equal(first, second, 'a per-request rebuild would orphan the buffered batch');
    resetAnalyticsForTests();
  });

  test('with no POSTHOG_API_KEY it is a working no-op, never a crash', async () => {
    resetAnalyticsForTests();
    const analytics = getAnalytics({});
    assert.doesNotThrow(() => analytics.projectCreated({
      projectId: 'p', actorPartyId: HOMEOWNER, baselineBudgetCents: BASELINE,
    }));
    await analytics.flush(); // must resolve, not reject
    resetAnalyticsForTests();
  });

  test('the unconfigured no-op still composes real services end to end', async () => {
    resetAnalyticsForTests();
    const { services } = setup({ analytics: getAnalytics({}) });
    const project = await services.identity.createProject({
      actorPartyId: HOMEOWNER, name: 'Maple Street', baselineBudgetCents: BASELINE,
    });
    assert.equal(project.baselineBudgetCents, BASELINE,
      'a missing PostHog key must never change domain behaviour');
    resetAnalyticsForTests();
  });
});
