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

import { createIdentityService } from '../identity/identity.mjs';
import { createPgStore as createIdentityPgStore } from '../identity/pg-store.mjs';
import { createPartyStore } from '../identity/parties.mjs';
import { createIdentityHttp } from '../identity/http.mjs';

import { createDecisionLog } from '../decision/decision-log.mjs';
import { createPgStore as createDecisionPgStore } from '../decision/pg-store.mjs';
import { createIdentityAuthz } from '../decision/identity-authz.mjs';
import { createDecisionHttp } from '../decision/http.mjs';

import { createChangeOrderService } from '../change_order/change-order.mjs';
import { createPgStore as createChangeOrderPgStore } from '../change_order/pg-store.mjs';
import { createChangeOrderHttp } from '../change_order/http.mjs';

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

/**
 * Build the whole service graph. Exported (rather than only the singleton) so
 * integration tests can build a container against a throwaway Neon branch
 * without touching process-wide state.
 * @param {{ urls?: Record<string,string> }} [opts]
 */
export function createContainer({ urls = {} } = {}) {
  const pools = {
    identity: createPool(urls.identity ?? urlFor('IDENTITY_DATABASE_URL')),
    decision: createPool(urls.decision ?? urlFor('DECISION_DATABASE_URL')),
    changeOrder: createPool(urls.changeOrder ?? urlFor('CHANGE_ORDER_DATABASE_URL')),
    ledger: createPool(urls.ledger ?? urlFor('LEDGER_DATABASE_URL')),
  };

  // See (2) above — one cache, four ledger bindings.
  const cache = createLedgerCache();
  const ledgerFor = (pool) => createPgLedger({ pool, cache });

  const ledgerReader = ledgerFor(pools.ledger);

  // ── Identity (the sole authorizer, ADR-0004) ────────────────────────────────
  const identityStore = createIdentityPgStore({
    pool: pools.identity,
    ledger: ledgerFor(pools.identity),
  });
  const identity = createIdentityService({ store: identityStore, ledger: ledgerReader });
  const parties = createPartyStore({ pool: pools.identity });

  // ── Decision Log (FR2, FR7) ─────────────────────────────────────────────────
  const decisionService = createDecisionLog({
    store: createDecisionPgStore({ pool: pools.decision }),
    ledger: ledgerFor(pools.decision),
    authz: createIdentityAuthz({ identity }),
  });

  // ── Change Orders + budget (FR3–FR8) ────────────────────────────────────────
  const changeOrderService = createChangeOrderService({
    store: createChangeOrderPgStore({ pool: pools.changeOrder }),
    ledger: ledgerFor(pools.changeOrder),
    identity,
  });

  return {
    pools,
    identity,
    parties,
    ledger: ledgerReader,
    services: { identity, decision: decisionService, changeOrder: changeOrderService },
    http: {
      identity: createIdentityHttp({ service: identity }),
      decision: createDecisionHttp({ service: decisionService }),
      changeOrder: createChangeOrderHttp({ service: changeOrderService, identity }),
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
