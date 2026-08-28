// The HTTP composition root (LINA-58) — where the R0 domain services are built
// once per process, with analytics injected, and where every response is
// guaranteed to flush the analytics buffer before it returns.
//
// WHY THIS FILE EXISTS
//
// The 8 Group-A domain-write events (LINA-55 / LINA-28 §2.3) are instrumented
// *inside* Identity, Decision Log and Change Order. `analytics` is an optional
// constructor arg on each, defaulting to a no-op sink — so with nothing injected
// the instrumentation runs and not one event leaves the process. Injection is
// what turns them on, and it belongs in exactly one place: here.
//
// THE FLUSH IS NOT OPTIONAL. The PostHog sink buffers captures and ships them in
// one batched POST /batch/. On a serverless runtime (Vercel, our R0 target) the
// process can be frozen the instant the response is written, so an unflushed
// buffer is a silently dropped batch. That is the single most likely way to ship
// instrumentation that looks wired and reports nothing — so `withAnalyticsFlush`
// below wraps handlers rather than leaving the flush to each call site's
// discipline. A flush is a `finally`, never a `then`: a handler that throws has
// usually emitted *more* interesting events than one that succeeded.
//
// ANALYTICS IS BEST-EFFORT, ALWAYS. Neither construction nor flushing may fail a
// domain write: `analyticsFromEnv()` with no key returns a working no-op, and
// `analytics.flush()` swallows sink errors internally. Nothing in this file
// introduces a new failure mode for a request that would otherwise have
// succeeded — asserted by composition.test.mjs.

import { analyticsFromEnv } from './analytics/index.mjs';
import { createIdentityService } from './identity/identity.mjs';
import { createDecisionLog } from './decision/decision-log.mjs';
import { createChangeOrderService } from './change_order/change-order.mjs';
import { createChangeOrderHttp } from './change_order/http.mjs';

// ── The per-process analytics singleton ─────────────────────────────────────
//
// Read the env ONCE. A serverless instance serves many requests off one module
// instance; re-reading per request would rebuild the sink (and its buffer) each
// time, which both costs allocations and — worse — orphans anything already
// buffered. `resetAnalyticsForTests` exists only so a test can prove the
// memoization rather than work around it.
let _analytics = null;

export function getAnalytics(env = process.env) {
  if (_analytics === null) _analytics = analyticsFromEnv(env);
  return _analytics;
}

export function resetAnalyticsForTests() {
  _analytics = null;
}

/**
 * Build the R0 domain services against a set of ports, with the process-wide
 * analytics injected into every one of them.
 *
 * Ports are passed in rather than constructed here so the same composition is
 * exercised by tests against in-memory adapters and by the runtime against
 * Postgres — the wiring under test is then literally the wiring that ships.
 *
 * `decision` is composed only when a decision store is supplied: the Decision
 * Log has no Postgres adapter yet (services/decision/ ships memory-adapters.mjs
 * only), so on the deployed target it is absent rather than silently backed by
 * process memory. Omitting it is loud at the route (no service to mount);
 * a memory fallback would look wired and lose every decision on cold start.
 *
 * PER-SERVICE LEDGER BINDINGS. `ledger` is the default port, but each service
 * may be given its OWN binding via `identityLedger` / `decisionLedger` /
 * `changeOrderLedger`. That is not a style choice: under the role-separated
 * deployment (LINA-56) each service holds its own pool as its own `<service>_app`
 * role, and a service's projection write and its `ledger.append_event(...)` must
 * land on the SAME connection to commit in one transaction (ADR-0006 §1). A
 * single shared ledger bound to someone else's pool would silently split that
 * atomicity in two. Tests that pass one in-memory `ledger` keep working unchanged.
 *
 * @param {Object} ports
 * @param {Object} ports.ledger                 Ledger port (append/recordBudgetEvent/currentBudget)
 * @param {Object} [ports.identityLedger]       Identity's ledger binding (default: ledger)
 * @param {Object} [ports.decisionLedger]       Decision's ledger binding (default: ledger)
 * @param {Object} [ports.changeOrderLedger]    Change Order's ledger binding (default: ledger)
 * @param {Object} ports.identityStore          Identity store adapter
 * @param {Object} ports.changeOrderStore       Change Order store adapter
 * @param {Object} [ports.decisionStore]        Decision store adapter (omit → no decision service)
 * @param {Object} [ports.decisionAuthz]        Decision authorizer
 * @param {Function} [ports.clock]              Decision clock
 * @param {Function} [ports.ids]                Decision id generator
 * @param {Object} [ports.analytics]            Override the singleton (tests only)
 */
export function createServices({
  ledger,
  identityLedger = ledger,
  decisionLedger = ledger,
  changeOrderLedger = ledger,
  identityStore,
  changeOrderStore,
  decisionStore = null,
  decisionAuthz = null,
  clock = undefined,
  ids = undefined,
  analytics = getAnalytics(),
}) {
  if (!ledger) throw new Error('createServices requires a { ledger } port');
  if (!identityStore) throw new Error('createServices requires an { identityStore } port');
  if (!changeOrderStore) throw new Error('createServices requires a { changeOrderStore } port');

  const identity = createIdentityService({ store: identityStore, ledger: identityLedger, analytics });

  // Change Order consumes the Identity SERVICE as its authorization port
  // (requireMember/roleOf), not a second copy of the membership rules — one
  // authorizer, so a permission fix lands everywhere at once (ADR-0004).
  const changeOrder = createChangeOrderService({
    store: changeOrderStore,
    ledger: changeOrderLedger,
    identity,
    analytics,
  });

  const decision = decisionStore
    ? createDecisionLog({
        store: decisionStore,
        ledger: decisionLedger,
        authz: decisionAuthz,
        clock,
        ids,
        analytics,
      })
    : null;

  return {
    analytics,
    identity,
    decision,
    changeOrder,
    changeOrderHttp: createChangeOrderHttp({ service: changeOrder, identity }),
  };
}

// The deployed-target builder lives in services/gateway/container.mjs, which
// calls `createServices` above with role-separated pools, per-service ledger
// bindings and the Decision Log's Postgres store. It is deliberately the ONLY
// env-facing composition root: an earlier `createServicesFromEnv` here built a
// second, single-pool graph with no decision service, and two builders is how a
// service ends up analytics-instrumented on one path and silent on the other.

/**
 * Wrap a route handler so the analytics buffer is flushed before its response is
 * returned — the guarantee that makes injection actually deliver events.
 *
 * Works for any handler shape: the return value is passed through untouched, and
 * a thrown error is re-thrown after the flush. The flush itself cannot fail the
 * request (`analytics.flush()` swallows sink errors), but we belt-and-brace it
 * with a catch here so a future sink that throws synchronously still cannot turn
 * a committed domain write into a 500.
 *
 * @param {Function} handler        async (…args) => response
 * @param {Object} [opts]
 * @param {Object} [opts.analytics] defaults to the process singleton
 */
export function withAnalyticsFlush(handler, { analytics = getAnalytics() } = {}) {
  if (typeof handler !== 'function') {
    throw new Error('withAnalyticsFlush requires a handler function');
  }
  return async function flushingHandler(...args) {
    try {
      return await handler(...args);
    } finally {
      // finally, not then: a 4xx/5xx path emits events too, and losing exactly
      // the failure telemetry would be the worst possible sampling bias.
      try {
        await analytics.flush();
      } catch {
        // Unreachable while flush() swallows internally; kept so it stays true.
      }
    }
  };
}
