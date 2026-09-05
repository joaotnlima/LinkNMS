// A small fixed-window, in-memory rate limiter for the ONE unauthenticated
// token-keyed read on the platform: GET /invitations/:token (LINA-182). The
// accept deep link's preview is reachable by any anonymous visitor, so it is the
// single place a token row can be probed without a session.
//
// WHY IN-MEMORY AND NOT A POSTGRES COUNTER. The deleted magic-link sign-in
// (ADR-0007 §4) kept its per-email/per-IP counters in Postgres because attacker
// traffic there was part of the same table it was already writing. A preview
// read writes NOTHING, so the honest analogue is a short-lived window of
// per-key counters that DISAPPEARS when the window closes — not an accreting
// audit trail nobody ever reads. ADR-0008 notes the production fix for
// unseated abuse is edge rate-limiting, and this is the framework-agnostic
// approximation of that edge: one shared process-local map, bounded, swept of
// expired windows, and honest that on a serverless pool it is per-instance.
//
// That honesty is why it is defence-in-depth, never the primary control. The
// primary controls stay: the token is 24 random bytes (~192 bits), only its
// SHA-256 is stored or ever looked up, and unknown and spent tokens return the
// IDENTICAL uniform 404 so the endpoint cannot be used as a token-validity
// oracle. The limiter throttles the burst an attacker can still throw at it.
//
// The handler applies the limiter to TWO buckets per request — one keyed on the
// token's hash (so a single leaked token cannot be burned through from many IPs)
// and one keyed on the client IP (so a single source rotating tokens is throttled
// in aggregate). Both must pass; `overLimit` is per-key and caller-composed.
//
// A null/empty key is never counted (no key → no bucket): on a deployment
// without a trustworthy client-IP header (gateway/client-ip.mjs returns null),
// the token-hash bucket still bites.
import { createHash } from 'node:crypto';

// Bounded map: distinct keys *within one window* are rare for a page-load
// preview endpoint; 10k is a ceiling that keeps a token-rotation flood from
// turning the limiter itself into a memory leak.
const MAX_KEYED = 10_000;

/** The one hashing story for the raw invitation token everywhere it is a key. */
export const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

/**
 * @param {Object} opts
 * @param {number} [opts.windowMs]  fixed window length, ms
 * @param {number} [opts.max]       max hits per key per window
 * @param {() => number} [opts.clock]  ms since epoch; injectable for tests
 */
export function createRateLimiter({ windowMs = 60_000, max = 20, clock = () => Date.now() } = {}) {
  /** @type {Map<string, { count: number, windowStart: number }>} */
  const hits = new Map();

  const sweep = (now) => {
    for (const [k, rec] of hits) {
      if (now >= rec.windowStart + windowMs) hits.delete(k);
    }
  };

  return {
    /**
     * Register one hit for `key` and report whether it overflowed the window's
     * `max`. A null/empty key is never counted. Expired windows are swept on
     * the way in, so fresh traffic after a window pass is allowed immediately.
     * @param {string|null|undefined} key
     */
    overLimit(key) {
      if (!key) return false;
      const now = clock();
      if (hits.size >= MAX_KEYED) sweep(now); // bound memory on a flood of keys
      const rec = hits.get(key);
      if (!rec || now >= rec.windowStart + windowMs) {
        hits.set(key, { count: 1, windowStart: now });
        return false;
      }
      rec.count += 1;
      return rec.count > max;
    },
    _size() {
      return hits.size;
    },
  };
}