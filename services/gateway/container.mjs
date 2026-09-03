// The composition root: builds every R0 service against Postgres and exposes the
// framework-agnostic HTTP handlers the Next route layer mounts (LINA-56).
//
// This is the ONLY place production wiring decisions are made, which is what
// keeps the Next routes thin adapters and the services independently testable.
// Three things are load-bearing here:
//
// 1. ONE POOL PER SERVICE ROLE (ADR-0006 §1, least privilege). Each service
//    connects as its own `<service>_app` role, so a bug in one service cannot
//    write another's tables and none of them can INSERT into ledger.audit_event
//    directly — they may only EXECUTE ledger.append_event. Set
//    IDENTITY_DATABASE_URL / DECISION_DATABASE_URL / CHANGE_ORDER_DATABASE_URL /
//    LEDGER_DATABASE_URL. DATABASE_URL is the single-role fallback for local dev
//    and CI; in production the four must be distinct.
//    NEVER point these at a `neon_superuser` member: superuser members bypass
//    `append_event`'s write guard entirely (finding from LINA-35).
//
// 2. ONE SHARED LEDGER CACHE. Each service writes ledger events through a pg
//    ledger instance bound to its OWN pool (so the append lands on that service's
//    transaction), but all of them share a single cache object. Without that, an
//    append via Identity would invalidate only Identity's cache and the ledger
//    reader could serve a budget/status/verify that is stale by up to the TTL —
//    a number the whole platform trusts, wrong for no reason.
//
// 3. A LAZY, MEMOISED SINGLETON. Serverless invocations reuse a warm module, so
//    pools are created once per instance and reused, never per request.
//
// 4. ANALYTICS INJECTED ONCE, HERE (LINA-58). Every service takes an optional
//    `analytics` defaulting to a no-op sink, so without this injection the
//    LINA-55 instrumentation runs and not one event leaves the process. The
//    matching half is the FLUSH in app/src/server/gateway.ts: the PostHog sink
//    batches, and on a serverless runtime an unflushed buffer is a dropped
//    batch. Injection without flush reports nothing.
import { createPool } from '../ledger/db.mjs';
import { createLedgerCache } from '../ledger/cache.mjs';
import { createPgLedger } from '../ledger/pg-ledger.mjs';
import { createLedgerHttp } from '../ledger/http.mjs';

import { createServices, getAnalytics } from '../composition.mjs';

import { createPgStore as createIdentityPgStore } from '../identity/pg-store.mjs';
import { createPartyStore } from '../identity/parties.mjs';
import { createPgSignInStore } from '../identity/sign-in-store.mjs';
import { createSignInService } from '../identity/sign-in.mjs';
import { createIdentityHttp } from '../identity/http.mjs';

import { createPgStore as createDecisionPgStore } from '../decision/pg-store.mjs';
import { createIdentityAuthz } from '../decision/identity-authz.mjs';
import { createDecisionHttp } from '../decision/http.mjs';

import { createPgStore as createChangeOrderPgStore } from '../change_order/pg-store.mjs';

import { createPgStore as createSchedulePgStore } from '../schedule/pg-store.mjs';

import { createPgStore as createWaitlistPgStore } from '../waitlist/pg-store.mjs';
import { sendWelcome } from '../waitlist/email-adapter.mjs';

// Per-service connection string with an explicit single-role fallback. Returning
// the fallback is right for CI/local (one migrator role, no role separation to
// test); production supplies all four.
function urlFor(varName) {
  const url = process.env[varName] || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(`${varName} (or DATABASE_URL) is required to serve the API`);
  }
  return url;
}

// Optional `SET ROLE` per service. Neon provisions the `<service>_app` roles as
// NOLOGIN, so when all four services share one login URL this is what still
// gives each of them only its own privileges. Unset → no SET ROLE (plain local
// Postgres, where the single dev role owns everything).
//
// DEPLOYMENT CONSTRAINT: setting any `*_DATABASE_ROLE` means the matching
// `*_DATABASE_URL` must be Neon's DIRECT endpoint, not the `-pooler` one. A
// transaction pooler does not give the client its own connection, so `SET ROLE`
// does not reliably hold — measured, not theorised (LINA-56: 10/21 integration
// assertions fail on `-pooler`, 21/21 pass direct). createPool refuses that
// combination outright rather than let the wrong role serve a request.
const roleFor = (varName) => process.env[varName] || undefined;

/**
 * Build the whole service graph. Exported (rather than only the singleton) so
 * integration tests can build a container against a throwaway Neon branch
 * without touching process-wide state.
 * @param {{ urls?: Record<string,string>, roles?: Record<string,string>, analytics?: Object }} [opts]
 */
export function createContainer({ urls = {}, roles = {}, analytics = getAnalytics() } = {}) {
  const pool = (svc, urlVar, roleVar) => createPool(
    urls[svc] ?? urlFor(urlVar),
    { role: roles[svc] ?? roleFor(roleVar) },
  );
  const pools = {
    // identity doubles as the RBAC / Clerk-mirror client (Auth Bridge LINA-140):
    // identity.users/orgs/memberships/roles/permissions/role_permissions/
    // resource_acls all live in schema `identity` and are served through this
    // pool, which runs as identity_app (0006 grants it DML, SELECT-only on the
    // role/permission catalog). The can() authorizer and Clerk webhook/JIT sync
    // (0A-impl-2) must source their client from here — never a separate pool
    // that would bypass the per-role grant boundary (ADR-0006 §1).
    identity: pool('identity', 'IDENTITY_DATABASE_URL', 'IDENTITY_DATABASE_ROLE'),
    decision: pool('decision', 'DECISION_DATABASE_URL', 'DECISION_DATABASE_ROLE'),
    changeOrder: pool('changeOrder', 'CHANGE_ORDER_DATABASE_URL', 'CHANGE_ORDER_DATABASE_ROLE'),
    schedule: pool('schedule', 'SCHEDULE_DATABASE_URL', 'SCHEDULE_DATABASE_ROLE'),
    ledger: pool('ledger', 'LEDGER_DATABASE_URL', 'LEDGER_DATABASE_ROLE'),
    waitlist: pool('waitlist', 'WAITLIST_DATABASE_URL', 'WAITLIST_DATABASE_ROLE'),
  };

  // See (2) above — one cache, four ledger bindings.
  const cache = createLedgerCache();
  const ledgerFor = (pool) => createPgLedger({ pool, cache });

  const ledgerReader = ledgerFor(pools.ledger);

  // Service construction itself lives in ../composition.mjs so the graph the
  // deployed target runs is the SAME function the composition tests exercise
  // against in-memory ports — including the analytics injection, without which
  // every service silently falls back to the no-op sink and no event ever leaves
  // the process (LINA-55/58). Only the ports differ here.
  const services = createServices({
    analytics,
    // Identity reads the ledger (budget summaries) through the ledger role and
    // writes through its own pool inside the store — see (1) above.
    ledger: ledgerReader,
    ledgers: {
      decision: ledgerFor(pools.decision),
      changeOrder: ledgerFor(pools.changeOrder),
      schedule: ledgerFor(pools.schedule),
    },
    identityStore: createIdentityPgStore({
      pool: pools.identity,
      ledger: ledgerFor(pools.identity),
    }),
    decisionStore: createDecisionPgStore({ pool: pools.decision }),
    // A factory: the authorizer is built over the Identity service that
    // createServices composes (ADR-0004 — one authorizer, no second copy).
    decisionAuthz: (identity) => createIdentityAuthz({ identity }),
    changeOrderStore: createChangeOrderPgStore({ pool: pools.changeOrder }),
    scheduleStore: createSchedulePgStore({ pool: pools.schedule }),
    waitlistStore: createWaitlistPgStore({ pool: pools.waitlist }),
    waitlistEmail: { sendWelcome },
  });

  const {
    identity, decision: decisionService, changeOrder: changeOrderService,
    schedule: scheduleService, waitlist: waitlistService,
  } = services;
  const parties = createPartyStore({ pool: pools.identity });

  // Magic-link sign-in (LINA-76, ADR-0007): the "proof" half of the session. Its
  // token table lives in schema `identity`, so it runs on the identity pool /
  // role — no ledger seam (minting/consuming a link writes no audit event). It
  // resolves the party through the same `parties` upsert the open-sign-in route
  // uses; the route mints the cookie via identity/session.mjs `mintSession`.
  const signIn = createSignInService({
    store: createPgSignInStore({ pool: pools.identity }),
    parties,
  });

  return {
    pools,
    identity,
    parties,
    signIn,
    analytics: services.analytics,
    ledger: ledgerReader,
    services: {
      identity, decision: decisionService, changeOrder: changeOrderService,
      schedule: scheduleService, waitlist: waitlistService,
    },
    http: {
      identity: createIdentityHttp({ service: identity }),
      decision: createDecisionHttp({ service: decisionService }),
      changeOrder: services.changeOrderHttp,
      schedule: services.scheduleHttp,
      ledger: createLedgerHttp({ ledger: ledgerReader, identity }),
      waitlist: services.waitlistHttp,
    },
    async close() {
      await Promise.all(Object.values(pools).map((p) => p.end()));
    },
  };
}

// ── The process singleton the Next routes use ────────────────────────────────
let singleton = null;

export function getContainer() {
  if (!singleton) singleton = createContainer();
  return singleton;
}
