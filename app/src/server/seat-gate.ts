// The retained v1 auth path (LINA-400 / Phase 12c tail).
//
// After the v2 cutover (Phase 11/12) the ONLY thing an authenticated request
// still needs from the old service graph is two reads on the `identity` schema:
//
//   • the ADR-0008 SEAT GATE  — "may this verified address come in at all"
//   • the email → PARTY mapping — the id-space join that preserves every
//     existing party's attribution history across the Clerk cutover (LINA-124).
//
// Both are plain pool queries (`seats.hasActiveSeat`, `parties.findOrCreateByEmail`)
// — no ledger append, no decision/change_order/schedule/analytics. They used to
// be reached through `@services/gateway/container.mjs`, whose `getContainer()`
// builds the WHOLE v1 service graph as one unit. That single import is what kept
// the now-dead v1 modules (decision, change_order, schedule, analytics, the
// ledger audit machinery) pinned on EVERY authenticated request. Constructing
// just the two stores here is what finally unpins them so they can retire.
//
// The identity-pool wiring — same env var, same `<service>_app` role, same
// direct-endpoint requirement — is copied verbatim from the container this
// replaces (services/gateway/container.mjs), so the ADR-0006 §1 privilege
// boundary is unchanged: identity_app holds SELECT on identity.seat and DML on
// identity.party and nothing else, and the request path still cannot seat
// anybody. It stays a lazy, memoised singleton for the same reason the container
// was one — a warm serverless instance reuses the pool, never one per request.
import { createPool } from '@services/ledger/db.mjs';
import { createSeatStore } from '@services/identity/seats.mjs';
import { createPartyStore } from '@services/identity/parties.mjs';

// Per-service connection string with the explicit single-role fallback the
// container documents: the four distinct URLs in production, DATABASE_URL for
// CI/local where one migrator role owns everything.
function urlFor(varName: string): string {
  const url = process.env[varName] || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(`${varName} (or DATABASE_URL) is required to serve the API`);
  }
  return url;
}

// Optional `SET ROLE` per service. Unset → no SET ROLE (plain local Postgres).
// createPool refuses role + a `-pooler` endpoint outright (the role would not
// hold on a transaction pooler), so this cannot silently serve as the wrong role.
const roleFor = (varName: string) => process.env[varName] || undefined;

let pool: ReturnType<typeof createPool> | null = null;
function identityPool() {
  if (!pool) {
    pool = createPool(urlFor('IDENTITY_DATABASE_URL'), {
      role: roleFor('IDENTITY_DATABASE_ROLE'),
    });
  }
  return pool;
}

let seatStore: ReturnType<typeof createSeatStore> | null = null;
/** The read-only ADR-0008 seat allowlist, over the identity pool. */
export function getSeatStore() {
  if (!seatStore) seatStore = createSeatStore({ pool: identityPool() });
  return seatStore;
}

let partyStore: ReturnType<typeof createPartyStore> | null = null;
/** The authoritative email → party mapping, over the identity pool. */
export function getPartyStore() {
  if (!partyStore) partyStore = createPartyStore({ pool: identityPool() });
  return partyStore;
}
