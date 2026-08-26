// Derived-read cache for the Ledger & Budget service (ADR-0006 §3).
//
// Only the expensive derivations are cached — budget summary, four-pillar status,
// and the audit chain-verify — with a short TTL AND explicit invalidation on
// every ledger append (an append to a project busts that project's cached reads).
// Mutations are never cached. This is deliberately a tiny in-process map: R0 is
// one homeowner + one GC on one build (single-digit concurrency), so a per-region
// serverless instance cache with TTL + append-invalidation is the right size. A
// shared cache (Redis/KV) is a later scale seam, not R0.

const DEFAULT_TTL_MS = 5_000;

export function createLedgerCache({ ttlMs = DEFAULT_TTL_MS, clock = () => Date.now() } = {}) {
  // key = `${projectId}:${kind}` -> { value, expiresAt }
  const entries = new Map();

  function key(projectId, kind) {
    return `${projectId}:${kind}`;
  }

  async function getOrCompute(projectId, kind, compute) {
    const k = key(projectId, kind);
    const hit = entries.get(k);
    const now = clock();
    if (hit && hit.expiresAt > now) {
      return { value: hit.value, hit: true };
    }
    const value = await compute();
    entries.set(k, { value, expiresAt: now + ttlMs });
    return { value, hit: false };
  }

  // Bust every cached derivation for a project. Called inside/after an append so a
  // stale budget/status/verify can never outlive the event that changed it.
  function invalidate(projectId) {
    const prefix = `${projectId}:`;
    for (const k of entries.keys()) {
      if (k.startsWith(prefix)) entries.delete(k);
    }
  }

  function clear() {
    entries.clear();
  }

  return { getOrCompute, invalidate, clear, _size: () => entries.size };
}
