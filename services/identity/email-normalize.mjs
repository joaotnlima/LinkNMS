// The ONE email normaliser for the Identity service.
//
// It used to live in sign-in.mjs (the magic-link service), which LINA-124
// deleted when Clerk took over authentication. The invitation path still needs
// it — an address typed into the invite form and the same address arriving from
// anywhere else must be ONE key (LINA-84), and `identity.party` has a UNIQUE
// index on the lower-cased address that depends on it.
//
// Shallow, deliberately: an address is a lookup key in R0, not a place to
// litigate RFC 5322. Requires an `@` and a dotted domain so we do not fire a
// send at obvious garbage. Lower-cased so `Ana@x.com` and `ana@x.com` are one.

/**
 * @param {unknown} email
 * @returns {string|null} the normalised address, or null when it is not one
 */
export function normalizeEmail(email) {
  const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return null;
  return clean;
}
