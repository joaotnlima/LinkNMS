/**
 * Where the portal lives (LINA-189).
 *
 * The marketing site and the portal are two separate Next apps on two separate
 * hosts, and the onboarding loop crosses from one to the other exactly once: a
 * confirmed founding claim hands the visitor to the portal's sign-up. That hand
 * -off is the only thing this file exists for.
 */

/** Production portal origin — overridable per environment. */
const DEFAULT_PORTAL_ORIGIN = 'https://portal.linknms.com';

export function portalOrigin(): string {
  const env = process.env.NEXT_PUBLIC_PORTAL_URL;
  return (env || DEFAULT_PORTAL_ORIGIN).replace(/\/$/, '');
}

/**
 * The portal's Clerk sign-up, carrying the address the seat was granted to.
 *
 * The address is a PREFILL, never a credential: the seat is keyed on the email,
 * and the portal only turns a Clerk account into a party once Clerk itself says
 * that address is verified (app/src/server/session.ts). So a hand-edited
 * `email` here buys nothing — it changes what is typed into a form field, and
 * the person still has to prove the inbox to Clerk. Carrying it just spares the
 * claimant from typing the address they already confirmed a minute ago, and
 * stops them signing up with a DIFFERENT address than the one holding the seat,
 * which is the most likely way this loop breaks for a real user.
 */
export function portalSignUpUrl(email: string, persona?: string | null): string {
  const url = new URL('/sign-up', portalOrigin());
  url.searchParams.set('email', email);
  // The persona the claim came in as (LINA-189), so the portal's account-setup
  // screen can preselect Owner or General contractor. Like `email` this is a
  // PREFILL and nothing more: it selects a radio button on a form the person
  // then submits themselves, and the role it sets is a label on their own party
  // that grants access to nothing (see the endpoint's contract). Only the two
  // known values are ever forwarded, so a hand-edited value cannot put an
  // arbitrary string in front of the portal.
  if (persona === 'owner' || persona === 'builder') {
    url.searchParams.set('persona', persona);
  }
  return url.toString();
}
