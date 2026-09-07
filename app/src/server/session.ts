// Who is acting — the ONE server-side answer (LINA-124, Auth Migration 0B).
//
// This file replaces `@/server/signin` and the `lnms_session` HMAC cookie it
// minted. Authentication is Clerk's now (LINA-123 auth-bridge: *authentication*
// → Clerk, *authorization* → our own catalog). Nothing here verifies a token by
// hand: `auth()` does that, from the middleware-verified request state.
//
// ── THE BRIDGE ───────────────────────────────────────────────────────────────
// The R0 domain — projects, decisions, change orders, every audit row — is keyed
// on `identity.party.id`, and a Clerk user id is a different id space. The join
// is the EMAIL ADDRESS, which is the same key the magic-link flow used: its
// consume step called `parties.findOrCreateByEmail` with the address the link
// proved control of. Clerk now supplies the proof instead of a one-time token,
// so the mapping — and therefore every existing party's attribution history —
// is preserved rather than re-keyed.
//
// ADR-0004 is intact: the acting party is derived from the verified session and
// nothing else. There is deliberately no header, query, or body override — not
// even a dev-only one, which is the escape hatch that ships to production by
// accident. `LINKNMS_OPEN_SIGNIN` (the no-proof demo door) is gone with it.
import { cache } from 'react';
import { auth, currentUser } from '@clerk/nextjs/server';

import { getContainer } from '@services/gateway/container.mjs';

export interface Session {
  partyId: string;
  /**
   * False until the person has been through account setup (LINA-189).
   *
   * A party row exists from the FIRST authenticated request — `findOrCreateByEmail`
   * upserts one so attribution has somewhere to land — but at that moment its
   * name is guessed off Clerk and its role is the `contractor` default. Neither
   * was chosen by the person, and on a trust product a role nobody picked is
   * worse than no role. This flag is how a surface tells that placeholder apart
   * from a profile its owner actually completed.
   */
  setupComplete: boolean;
}

/**
 * The three states a request can be in, kept distinct because they are three
 * different things to SHOW someone:
 *
 *  - `anonymous` — no Clerk session. Send them to sign in.
 *  - `unseated`  — a real, verified Clerk account with NO active seat
 *                  (ADR-0008). Authenticated, not admitted. Sending these to
 *                  /sign-in would be a redirect loop into a page that says they
 *                  are already signed in, so they get their own honest answer.
 *  - `party`     — seated, and mapped to the identity party that owns their
 *                  history on the record.
 */
export type SessionState =
  | { kind: 'anonymous' }
  | { kind: 'unseated'; email: string }
  | { kind: 'party'; session: Session };

/**
 * True when Clerk is provisioned in this environment. A preview/CI build with no
 * keys must still compile and boot, so every entry point checks this first and
 * treats "not configured" as "nobody is signed in" — fail closed, never fail
 * open, and never crash the render.
 */
export function clerkConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}

/**
 * Resolve the request's Clerk session all the way to a party.
 *
 * `cache()` (per-request, React server-side) matters here: a page renders many
 * server components, each of which may ask who is acting, and the resolution
 * ends in a seat lookup plus a Postgres upsert. Without memoisation one page
 * view would run the whole chain a dozen times.
 */
export const sessionState = cache(async (): Promise<SessionState> => {
  if (!clerkConfigured()) return { kind: 'anonymous' };

  const { userId } = await auth();
  if (!userId) return { kind: 'anonymous' };

  const user = await currentUser();
  // Only a VERIFIED address may become a party: an unverified one would let
  // someone claim another person's record simply by typing their email into a
  // profile field. Clerk exposes the verification state per address, so this
  // prefers the primary address and accepts it only if Clerk says it is verified.
  const email = verifiedEmailOf(user);
  if (!email) return { kind: 'anonymous' };

  // ── THE SEAT GATE (ADR-0008) ───────────────────────────────────────────────
  // It used to sit in the magic-link service, which declined to MAIL a link to
  // an unseated address. That service is gone, so the gate moved here — to the
  // one line that turns a verified identity into a party. Without it, anybody
  // who can complete a Clerk sign-up becomes a party on the record: open
  // registration on a trust product, which is precisely what 0004_identity.sql
  // was written to prevent. It is checked BEFORE findOrCreateByEmail so an
  // unseated visitor leaves no row behind.
  const container = getContainer();
  if (!(await container.seats.hasActiveSeat(email))) return { kind: 'unseated', email };

  const party = await container.parties.findOrCreateByEmail({
    email,
    displayName: user?.fullName ?? undefined,
  });
  return {
    kind: 'party',
    session: { partyId: party.id, setupComplete: party.setupComplete === true },
  };
});

/**
 * The acting party, or null when the request carries no admitted session —
 * anonymous and unseated are both "nobody is acting" to a data path, and the
 * distinction only matters to what a PAGE shows (see `sessionState`).
 */
export async function currentSession(): Promise<Session | null> {
  const state = await sessionState();
  return state.kind === 'party' ? state.session : null;
}

type ClerkUser = Awaited<ReturnType<typeof currentUser>>;

function verifiedEmailOf(user: ClerkUser): string | null {
  if (!user) return null;
  const addresses = user.emailAddresses ?? [];
  const primary = addresses.find((a) => a.id === user.primaryEmailAddressId) ?? addresses[0];
  if (!primary) return null;
  if (primary.verification?.status !== 'verified') return null;
  return primary.emailAddress;
}

/** Convenience for surfaces that only need the yes/no. */
export async function isSignedIn(): Promise<boolean> {
  return (await currentSession()) !== null;
}
