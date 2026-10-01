// The retained v1 auth path, now on @modules (LINA-401 / Phase 12c tail).
//
// After the v2 cutover (Phase 11/12) the ONLY thing an authenticated request
// still needs from the old identity layer is two reads on the `identity` schema:
//
//   • the ADR-0008 SEAT GATE  — "may this verified address come in at all"
//   • the email → PARTY mapping — the id-space join that preserves every
//     existing party's attribution history across the Clerk cutover (LINA-124)
//
// LINA-400 isolated these two reads here so session.ts could stay pure Clerk
// logic while this file carried the last `@services` imports (the slim
// seat-store/party-store pair over a dedicated identity pool). That made this
// file — with session.ts — the sole entry on the CI v1-deprecation whitelist.
//
// LINA-401 finishes the job: the two reads now live in
// `@modules/identity/infra/auth-bridge.mjs` and run over the SAME shared v2 pool
// the viewer resolves person/org on (`createIdentityStore(getPool())` in
// viewer.ts). No `@services` import remains anywhere in app/src, so the gate
// runs fully whitelist-free. The privilege trade-off of folding onto the v2 pool
// (ADR-0006 §1 role separation → code-enforced, consistent with ADR-0026 and the
// rest of v2) is documented on createAuthBridgeStore.
import { createAuthBridgeStore } from '@modules/identity/infra/auth-bridge.mjs';
import { getPool } from './v2/registry';

// One bridge instance over the shared v2 pool. registry.ts owns the pool and
// does NOT import this file, so this import is not a cycle — the same shape
// viewer.ts uses for the identity store.
let bridge: ReturnType<typeof createAuthBridgeStore> | null = null;
function authBridge() {
  if (!bridge) bridge = createAuthBridgeStore(getPool());
  return bridge;
}

/** The read-only ADR-0008 seat allowlist. */
export function getSeatStore() {
  return authBridge();
}

/** The authoritative email → party mapping. */
export function getPartyStore() {
  return authBridge();
}
