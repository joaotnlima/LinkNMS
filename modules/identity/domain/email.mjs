// The ONE email normaliser for the identity module.
//
// Ported verbatim from services/identity/email-normalize.mjs (LINA-401) as the
// v1 service layer retires. It MUST stay byte-for-byte identical to how seats
// are granted (scripts/grant-seat.mjs replicates the same rule): the seat gate
// matches a verified address against `identity.seat`, and a normalisation that
// drifted from the grant side would silently lock a seated person out.
//
// Shallow, deliberately: an address is a lookup key in R0, not a place to
// litigate RFC 5322. Requires an `@` and a dotted domain so we do not match
// obvious garbage. Lower-cased so `Ana@x.com` and `ana@x.com` are one key —
// the same key `identity.party`'s UNIQUE(lower(email)) index depends on.

/**
 * @param {unknown} email
 * @returns {string|null} the normalised address, or null when it is not one
 */
export function normalizeEmail(email) {
  const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return null;
  return clean;
}
