// Fail CLOSED without crashing the render (LINA-231 reopen / LINA-57).
//
// Session resolution is the ONE thing every server surface does before it shows
// anything, and it ends in a chain that can throw: Clerk's `auth()` +
// `currentUser()` (a network call to Clerk's backend API) and two Postgres calls
// (the seat gate + the party upsert). Before this, any transient failure in that
// chain propagated straight through the render into the root error boundary —
// "This record could not be loaded" — even on a page that reads NO shared record,
// like the new-build wizard. A founder creating a brand-new build saw an outage
// screen telling them a record they had not created yet could not be reached.
//
// `server/session.ts` already states its own contract for the not-configured
// case: "fail closed, never fail open, and never crash the render." A transient
// throw is the same class of event — we do not know who is acting — so it must
// resolve the same way: to the most restrictive answer, not to a crash. This
// helper is that seam, kept dependency-free so the fail-closed behaviour has a
// runnable unit test without standing up Clerk or Postgres.
//
// Fail CLOSED, deliberately: the fallback for an unknown session is `anonymous`,
// the least-privileged state, so a blip sends a signed-in visitor to a sign-in
// redirect that self-heals on the next request — never renders a members-only
// surface to someone we could not authenticate. And this does NOT weaken LINA-57:
// pages that read the shared record still call `getBuild`/`getRecord` AFTER the
// auth gate, and those reads are unwrapped, so a real record outage still surfaces
// as the honest "could not be loaded" boundary. Only the auth PROBE stops crashing.

/**
 * Run `resolve`, returning its value, or `fallback` if it throws. The error is
 * logged (never swallowed silently) so the server-side stack still reaches the
 * logs for diagnosis — the digest on the error surface is otherwise the only
 * handle on a failure, and failing closed removes that surface.
 *
 * `label` names the call site in the log line.
 */
export async function failClosed<T>(
  resolve: () => Promise<T>,
  fallback: T,
  label: string,
): Promise<T> {
  try {
    return await resolve();
  } catch (err) {
    // eslint-disable-next-line no-console -- server log is the diagnosis handle
    console.error(`[${label}] resolution failed; failing closed`, err);
    return fallback;
  }
}
