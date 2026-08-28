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
import { createPool } from '../ledger/db.mjs';
import { createLedgerCache } from '../ledger/cache.mjs';
import { createPgLedger } from '../ledger/pg-ledger.mjs';
import { createLedgerHttp } from '../ledger/http.mjs';

// Service construction itself lives in composition.mjs (LINA-58) so the graph
// the analytics tests exercise is literally the graph that ships. This file
// supplies only the Postgres-specific ports it cannot know about.
import { createServices, getAnalytics } from '../composition.mjs';

import { createPgStore as createIdentityPgStore } from '../identity/pg-store.mjs';
import { createPartyStore } from '../identity/parties.mjs';
import { createIdentityHttp } from '../identity/http.mjs';

import { createPgStore as createDecisionPgStore } from '../decision/pg-store.mjs';
import { createIdentityAuthz } from '../decision/identity-authz.mjs';
import { createDecisionHttp } from '../decision/http.mjs';

import { createPgStore as createChangeOrderPgStore } from '../change_order/pg-store.mjs';

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
    identity: pool('identity', 'IDENTITY_DATABASE_URL', 'IDENTITY_DATABASE_ROLE'),
    decision: pool('decision', 'DECISION_DATABASE_URL', 'DECISION_DATABASE_ROLE'),
    changeOrder: pool('changeOrder', 'CHANGE_ORDER_DATABASE_URL', 'CHANGE_ORDER_DATABASE_ROLE'),
    ledger: pool('ledger', 'LEDGER_DATABASE_URL', 'LEDGER_DATABASE_ROLE'),
  };

  // See (2) above — one cache, four ledger bindings.
  const cache = createLedgerCache();
  const ledgerFor = (pool) => createPgLedger({ pool, cache });

  const ledgerReader = ledgerFor(pools.ledger);

  const identityLedger = ledgerFor(pools.identity);

  // Ports this file owns (Postgres-specific); the service graph itself — and the
  // analytics injection that makes the LINA-55 event spine actually emit — is
  // assembled by composition.mjs. Decision's authorizer needs the Identity
  // SERVICE, which does not exist until createServices returns, so it is passed
  // as a late-bound indirection rather than by building a second Identity.
  let identityRef = null;
  const lateIdentity = { authorize: (ctx) => identityRef.authorize(ctx) };
  const graph = createServices({
    ledger: ledgerReader,
    identityLedger,
    decisionLedger: ledgerFor(pools.decision),
    changeOrderLedger: ledgerFor(pools.changeOrder),
    identityStore: createIdentityPgStore({ pool: pools.identity, ledger: identityLedger }),
    decisionStore: createDecisionPgStore({ pool: pools.decision }),
    decisionAuthz: createIdentityAuthz({ identity: lateIdentity }),
    changeOrderStore: createChangeOrderPgStore({ pool: pools.changeOrder }),
    analytics,
  });
  identityRef = graph.identity;

  const { identity, decision: decisionService, changeOrder: changeOrderService } = graph;
  const parties = createPartyStore({ pool: pools.identity });

  return {
    pools,
    identity,
    parties,
    analytics: graph.analytics,
    ledger: ledgerReader,
    services: { identity, decision: decisionService, changeOrder: changeOrderService },
    http: {
      identity: createIdentityHttp({ service: identity }),
      decision: createDecisionHttp({ service: decisionService }),
      changeOrder: graph.changeOrderHttp,
      ledger: createLedgerHttp({ ledger: ledgerReader, identity }),
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
