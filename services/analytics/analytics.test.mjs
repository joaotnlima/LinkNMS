// Analytics contract tests (LINA-55, contract of record: LINA-28 doc
// `r0-metrics-posthog-spec`). These are the Product Analytics Lead's acceptance
// gate expressed as executable assertions:
//
//   1. All 8 Group-A domain-write events are emitted by the REAL services (not a
//      stub), each carrying the `project` group + a server-authenticated
//      `distinct_id` == party_id.
//   2. `is_self_approval` is present on `change_order_decided` and computed
//      server-side (0 for the only path the FR4 gate allows).
//   3. No PII / free text in ANY property payload — enforced by a hard guard, so
//      a future property that leaks a title or a name fails the build.
//   4. Analytics is best-effort: a broken sink can never fail a domain write.
//
// Run: node --test services/analytics/analytics.test.mjs
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAnalytics, createNoopAnalytics } from './analytics.mjs';
import { createMemorySink, createPosthogSink } from './sink.mjs';
import { EVENTS, assertNoPii, hoursBetween, AnalyticsContractError } from './events.mjs';
import { analyticsFromEnv } from './config.mjs';

// Real services under test — the instrumentation must live in the domain code,
// not in the test.
import { createIdentityService } from '../identity/identity.mjs';
import { createMemoryStore as createIdentityStore } from '../identity/store.mjs';
import { createMemoryLedger as createIdentityLedger } from '../identity/ledger-port.mjs';

import { createDecisionLog, ACTIONS } from '../decision/decision-log.mjs';
import {
  createMemoryLedger as createDecisionLedger,
  createMemoryStore as createDecisionStore,
  createMemoryAuthz,
  createTestClock,
  createSeqIds,
} from '../decision/memory-adapters.mjs';

import { createChangeOrderService } from '../change_order/change-order.mjs';
import {
  createInMemoryLedger,
  createInMemoryIdentity,
  createInMemoryStore,
} from '../change_order/ports.mjs';

const PROJECT = 'proj-1';
const HOMEOWNER = 'party-homeowner';
const GC = 'party-gc';
const RELEASE = 'abc1234';

// Every event must carry these super-properties (§2.2).
const SUPER_PROPS = ['project_id', 'actor_party_id', 'actor_role', 'release_sha', 'surface'];

function makeAnalytics() {
  const sink = createMemorySink();
  // onError rethrows so a swallowed contract violation can never hide a bug from
  // this suite. Production passes a logger instead.
  const errors = [];
  const analytics = createAnalytics({ sink, releaseSha: RELEASE, onError: (e) => errors.push(e) });
  return { sink, analytics, errors };
}

function only(sink, event) {
  const hits = sink.byEvent(event);
  assert.equal(hits.length, 1, `expected exactly one ${event}, got ${hits.length}`);
  return hits[0];
}

// The shared per-event invariants the analytics lead verifies on every event.
function assertEventEnvelope(capture, { projectId = PROJECT, distinctId } = {}) {
  for (const key of SUPER_PROPS) {
    assert.ok(key in capture.properties, `${capture.event} must carry super-property ${key}`);
  }
  assert.equal(capture.properties.project_id, projectId);
  assert.equal(capture.properties.release_sha, RELEASE);
  assert.deepEqual(capture.groups, { project: projectId }, `${capture.event} must be grouped on the project`);
  if (distinctId) {
    assert.equal(capture.distinctId, distinctId, `${capture.event} distinct_id must be the acting party_id`);
    assert.equal(capture.properties.actor_party_id, distinctId);
  }
}

// ---------------------------------------------------------------------------
// 1. Identity service — project_created, gc_invited, gc_joined
// ---------------------------------------------------------------------------
describe('identity spine: project_created / gc_invited / gc_joined', () => {
  async function setup() {
    const { sink, analytics, errors } = makeAnalytics();
    const ledger = createIdentityLedger();
    const store = createIdentityStore({ ledger });
    const svc = createIdentityService({ store, ledger, analytics });
    return { svc, sink, errors };
  }

  test('the full activation flow emits all three events with group + identity', async () => {
    const { svc, sink, errors } = await setup();

    const project = await svc.createProject({
      actorPartyId: HOMEOWNER, name: 'Maple Street', baselineBudgetCents: 450_000_00,
    });

    const created = only(sink, EVENTS.PROJECT_CREATED);
    assertEventEnvelope(created, { projectId: project.id, distinctId: HOMEOWNER });
    assert.equal(created.properties.actor_role, 'owner');
    assert.equal(created.properties.baseline_budget_cents, 450_000_00);
    assert.equal(created.properties.has_baseline, true);

    // §2.1 identity model: identify(party_id) + group('project', project_id).
    assert.ok(sink.identifies.some((i) => i.distinctId === HOMEOWNER && i.properties.role === 'owner'));
    assert.ok(sink.groups.some((g) => g.groupType === 'project' && g.groupKey === project.id));

    const { token } = await svc.inviteCounterparty({ actorPartyId: HOMEOWNER, projectId: project.id });
    const invited = only(sink, EVENTS.GC_INVITED);
    assertEventEnvelope(invited, { projectId: project.id, distinctId: HOMEOWNER });
    assert.equal(invited.properties.invite_method, 'link');
    // The raw single-use token must never reach analytics.
    assert.ok(!JSON.stringify(invited).includes(token), 'invite token must never appear in an event');

    await svc.acceptInvitation({ actorPartyId: GC, token });
    const joined = only(sink, EVENTS.GC_JOINED);
    assertEventEnvelope(joined, { projectId: project.id, distinctId: GC });
    assert.equal(joined.properties.actor_role, 'counterparty');
    assert.equal(typeof joined.properties.hours_since_created, 'number');

    assert.deepEqual(errors, [], 'no analytics error should be swallowed on the happy path');
  });

  test('a rejected write emits nothing — events describe committed state only', async () => {
    const { svc, sink } = await setup();
    await assert.rejects(svc.createProject({ actorPartyId: HOMEOWNER, name: '   ', baselineBudgetCents: 0 }));
    await assert.rejects(svc.inviteCounterparty({ actorPartyId: HOMEOWNER, projectId: 'nope' }));
    assert.equal(sink.captures.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Decision Log — decision_logged, decision_amended
// ---------------------------------------------------------------------------
describe('decision spine: decision_logged / decision_amended', () => {
  function setup() {
    const { sink, analytics } = makeAnalytics();
    const authz = createMemoryAuthz();
    for (const party of [HOMEOWNER, GC]) {
      authz.grant(PROJECT, party, [ACTIONS.RECORD, ACTIONS.REVISE, ACTIONS.VIEW]);
    }
    const svc = createDecisionLog({
      store: createDecisionStore(),
      ledger: createDecisionLedger(),
      authz,
      clock: createTestClock(),
      ids: createSeqIds('id'),
      analytics,
    });
    return { svc, sink };
  }

  test('record then revise emits one logged + one amended, with rev, never the text', async () => {
    const { svc, sink } = setup();
    const d = await svc.record(PROJECT, HOMEOWNER, {
      title: 'Use white oak flooring',
      body: 'Homeowner picked white oak over laminate at the Tuesday walkthrough.',
    });

    const logged = only(sink, EVENTS.DECISION_LOGGED);
    assertEventEnvelope(logged, { distinctId: HOMEOWNER });
    assert.equal(logged.properties.decision_id, d.id);
    assert.equal(logged.properties.has_body, true);
    assert.equal(logged.properties.body_len, 68);
    // Presence + length only: neither the title nor the body may be recoverable.
    assert.ok(!JSON.stringify(logged).includes('white oak'));

    await svc.revise(d.id, GC, { title: 'Use rift-sawn white oak', body: 'Upgraded cut.' });
    const amended = only(sink, EVENTS.DECISION_AMENDED);
    assertEventEnvelope(amended, { distinctId: GC });
    assert.equal(amended.properties.decision_id, d.id);
    assert.equal(amended.properties.rev, 2, 'amend appends past rev 1 — the immutability promise');
  });
});

// ---------------------------------------------------------------------------
// 3. Change Orders — change_order_raised, change_order_decided,
//    budget_event_written (+ the is_self_approval gate)
// ---------------------------------------------------------------------------
describe('change-order spine: raised / decided / budget_event_written', () => {
  const BASELINE = 5_000_000;
  const DELTA = 120_000;

  function setup() {
    const { sink, analytics } = makeAnalytics();
    const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, BASELINE]]) });
    const identity = createInMemoryIdentity({
      memberships: [
        { projectId: PROJECT, partyId: HOMEOWNER, role: 'homeowner' },
        { projectId: PROJECT, partyId: GC, role: 'general_contractor' },
      ],
    });
    const svc = createChangeOrderService({ store: createInMemoryStore(), ledger, identity, analytics });
    return { svc, sink, ledger };
  }

  function propose(svc, actor = GC) {
    return svc.propose(PROJECT, actor, {
      title: 'Upgrade to oak flooring',
      costDeltaCents: DELTA,
      scopeImpactNote: 'Replace laminate with white oak in living areas',
      scheduleImpactDays: 5,
      qualityFlag: true,
    });
  }

  test('propose emits change_order_raised with flags and cents, never the title or notes', () => {
    const { svc, sink } = setup();
    const co = propose(svc);

    const raised = only(sink, EVENTS.CHANGE_ORDER_RAISED);
    assertEventEnvelope(raised, { distinctId: GC });
    assert.equal(raised.properties.actor_role, 'general_contractor');
    assert.equal(raised.properties.change_order_id, co.id);
    assert.equal(raised.properties.cost_delta_cents, DELTA);
    assert.equal(raised.properties.linked_to_decision, false);
    assert.equal(raised.properties.schedule_impact_days, 5);
    assert.equal(raised.properties.has_scope_note, true);
    assert.equal(raised.properties.quality_flag, true);
    // The note text is a has_* flag, not content.
    assert.ok(!JSON.stringify(raised).includes('white oak'));
    assert.ok(!JSON.stringify(raised).includes('Upgrade to oak'));
  });

  test('approval emits change_order_decided (is_self_approval=false) + budget_event_written', () => {
    const { svc, sink } = setup();
    const co = propose(svc, GC);
    sink.reset();

    svc.decide(co.id, HOMEOWNER, { decision: 'approve' });

    const decided = only(sink, EVENTS.CHANGE_ORDER_DECIDED);
    assertEventEnvelope(decided, { distinctId: HOMEOWNER });
    assert.equal(decided.properties.decision, 'approved');
    assert.equal(decided.properties.cost_delta_cents, DELTA);
    assert.equal(decided.properties.decided_by_role, 'homeowner');
    // A3 gate: the property must be PRESENT and false — a true here in prod means
    // the server-side self-approval gate regressed.
    assert.ok('is_self_approval' in decided.properties, 'is_self_approval must always be sent');
    assert.equal(decided.properties.is_self_approval, false);
    assert.equal(typeof decided.properties.hours_since_raised, 'number');

    const budget = only(sink, EVENTS.BUDGET_EVENT_WRITTEN);
    assertEventEnvelope(budget, { distinctId: HOMEOWNER });
    assert.equal(budget.properties.delta_cents, DELTA);
    assert.equal(budget.properties.new_current_cents, BASELINE + DELTA,
      'new_current_cents must be the server-authoritative post-move total');
  });

  test('rejection emits decided but NOT budget_event_written — the budget did not move', () => {
    const { svc, sink } = setup();
    const co = propose(svc, GC);
    sink.reset();

    svc.decide(co.id, HOMEOWNER, { decision: 'reject' });

    assert.equal(only(sink, EVENTS.CHANGE_ORDER_DECIDED).properties.decision, 'rejected');
    assert.equal(sink.byEvent(EVENTS.BUDGET_EVENT_WRITTEN).length, 0);
  });

  test('a self-decision is refused by the server and emits nothing at all', () => {
    const { svc, sink } = setup();
    const co = propose(svc, GC);
    sink.reset();

    assert.throws(() => svc.decide(co.id, GC, { decision: 'approve' }), (err) => err.status === 403);
    assert.equal(sink.captures.length, 0,
      'the FR4 gate blocks before any write, so there is no decided event to emit');
  });

  test('an idempotent replay of a decision does not double-count the events', () => {
    const { svc, sink } = setup();
    const co = propose(svc, GC);
    sink.reset();

    svc.decide(co.id, HOMEOWNER, { decision: 'approve', idempotencyKey: 'k-1' });
    svc.decide(co.id, HOMEOWNER, { decision: 'approve', idempotencyKey: 'k-1' });

    assert.equal(sink.byEvent(EVENTS.CHANGE_ORDER_DECIDED).length, 1);
    assert.equal(sink.byEvent(EVENTS.BUDGET_EVENT_WRITTEN).length, 1,
      'budget_event_written must match the ledger budget_event rows exactly once');
  });

  test('a throwing sink can never fail a domain write (analytics is best-effort)', () => {
    const brokenSink = {
      capture() { throw new Error('posthog is down'); },
      identify() { throw new Error('posthog is down'); },
      groupIdentify() { throw new Error('posthog is down'); },
      async flush() {},
    };
    const swallowed = [];
    const analytics = createAnalytics({ sink: brokenSink, onError: (e) => swallowed.push(e) });
    const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, BASELINE]]) });
    const identity = createInMemoryIdentity({
      memberships: [
        { projectId: PROJECT, partyId: HOMEOWNER, role: 'homeowner' },
        { projectId: PROJECT, partyId: GC, role: 'general_contractor' },
      ],
    });
    const svc = createChangeOrderService({ store: createInMemoryStore(), ledger, identity, analytics });

    const co = svc.propose(PROJECT, GC, { title: 'x', costDeltaCents: DELTA });
    const decided = svc.decide(co.id, HOMEOWNER, { decision: 'approve' });

    assert.equal(decided.status, 'approved');
    assert.equal(ledger.currentBudget(PROJECT).currentCents, BASELINE + DELTA);
    assert.ok(swallowed.length >= 2, 'sink failures are observed, not propagated');
  });
});

// ---------------------------------------------------------------------------
// 4. The PII guard itself (§3) — the property the analytics lead audits
// ---------------------------------------------------------------------------
describe('PII guard (§3)', () => {
  for (const key of ['title', 'co_title', 'display_name', 'scope_note', 'body', 'raw_token', 'email']) {
    test(`rejects a "${key}" property outright`, () => {
      assert.throws(() => assertNoPii({ [key]: 'x' }, 'e'), AnalyticsContractError);
    });
  }

  test('allows the length/presence/count encodings that replace free text', () => {
    assert.doesNotThrow(() => assertNoPii({ body_len: 66, has_body: true, co_count: 2 }, 'e'));
  });

  test('rejects any long free-text string value even under an innocent key', () => {
    assert.throws(() => assertNoPii({ context: 'a'.repeat(65) }, 'e'), AnalyticsContractError);
  });

  test('money must be integer cents, never a float (§2.2)', () => {
    assert.doesNotThrow(() => assertNoPii({ cost_delta_cents: 120_000 }, 'e'));
    assert.throws(() => assertNoPii({ cost_delta_cents: 1200.5 }, 'e'), AnalyticsContractError);
  });

  test('a guard violation drops the event instead of reaching the sink', () => {
    const sink = createMemorySink();
    const errors = [];
    const analytics = createAnalytics({ sink, onError: (e) => errors.push(e) });
    // A float delta is a contract violation: it must never be shipped.
    analytics.budgetEventWritten({
      projectId: PROJECT, actorPartyId: HOMEOWNER, changeOrderId: 'co-1',
      deltaCents: 10.5, newCurrentCents: 10,
    });
    assert.equal(sink.captures.length, 0);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof AnalyticsContractError);
  });

  test('hoursBetween uses server timestamps and rounds to one decimal', () => {
    assert.equal(hoursBetween('2026-08-27T00:00:00.000Z', '2026-08-27T03:30:00.000Z'), 3.5);
    assert.equal(hoursBetween('nonsense', '2026-08-27T00:00:00.000Z'), null);
  });
});

// ---------------------------------------------------------------------------
// 5. Sinks + env wiring
// ---------------------------------------------------------------------------
describe('sinks and env wiring', () => {
  test('the posthog sink batches to /batch/ with $groups and the project api key', async () => {
    const calls = [];
    const sink = createPosthogSink({
      apiKey: 'phc_test', host: 'https://eu.i.posthog.com/',
      fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; },
    });
    sink.capture({ event: 'x', distinctId: HOMEOWNER, properties: { a: 1 }, groups: { project: PROJECT } });
    await sink.flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://eu.i.posthog.com/batch/');
    assert.equal(calls[0].body.api_key, 'phc_test');
    assert.equal(calls[0].body.batch[0].distinct_id, HOMEOWNER);
    assert.deepEqual(calls[0].body.batch[0].properties.$groups, { project: PROJECT });
  });

  test('a network failure in the sink is swallowed, not thrown at the caller', async () => {
    const sink = createPosthogSink({
      apiKey: 'phc_test', fetchImpl: async () => { throw new Error('ECONNRESET'); },
    });
    sink.capture({ event: 'x', distinctId: HOMEOWNER, properties: {} });
    await assert.doesNotReject(sink.flush());
  });

  test('with no POSTHOG_API_KEY the wiring degrades to a silent no-op, never a crash', async () => {
    const analytics = analyticsFromEnv({ RELEASE_SHA: RELEASE });
    assert.doesNotThrow(() => analytics.projectCreated({
      projectId: PROJECT, actorPartyId: HOMEOWNER, baselineBudgetCents: 1, createdAt: '2026-08-27T00:00:00.000Z',
    }));
    await analytics.flush();
  });

  test('createNoopAnalytics exposes the full facade so services always have a real dep', () => {
    const noop = createNoopAnalytics();
    for (const m of Object.keys(EVENTS)) {
      const method = m.toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase());
      assert.equal(typeof noop[method], 'function', `noop analytics must implement ${method}()`);
    }
  });
});
