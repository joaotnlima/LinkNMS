// Home — the portal root.
//
// This page used to redirect straight to a hard-coded DEMO_PROJECT_ID, which was
// the right shape while the data was a fixture and the wrong one the moment it
// became real. It became the FR1 doorway in LINA-57, and is now the D1-new
// first-time empty portal state (LINA-133): the screen onboarding/setup
// (LINA-132) hands off to once a profile is complete.
//
// KNOWN GAP, stated rather than papered over — and the reason this route can
// render the empty state unconditionally: R0 has no "list my projects"
// endpoint, so there is nothing to branch on. Every signed-in user's portfolio
// is empty as far as the client can tell, and a returning owner reaches their
// record by its URL (said plainly in the footnote). Adding GET /projects would
// be a small Identity change; when it lands, this route branches here between
// <EmptyPortal/> and a portfolio list. It is deliberately NOT smuggled in as a
// client-side list of remembered ids, which would be a second, un-authorized
// source of truth about who is on what.
import { redirect } from 'next/navigation';
import { EmptyPortal } from '@/components/EmptyPortal';
import { sessionState } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // Three states, three answers (LINA-124). An unseated visitor is signed in —
  // bouncing them to /sign-in would loop them through a page telling them they
  // already are — so they get the honest "no seat yet" screen instead.
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in');
  if (state.kind === 'unseated') redirect('/no-access');

  // ── THE FOURTH STATE: SEATED BUT NEVER SET UP (LINA-189) ────────────────────
  // /sign-up force-redirects to /onboarding/setup, so the happy path arrives
  // here with a finished profile. Every OTHER way in skips that screen: signing
  // IN rather than up (the returning claimant), abandoning the form, a failed
  // submit, or a deep link. Those people got a party row anyway — named off
  // Clerk, roled `contractor` by default — and nothing ever asked them again.
  //
  // That is not cosmetic on this product. The role is the label beside every
  // decision they ever record, so an owner silently filed as the contractor is
  // a wrong answer to "who decided this". Sending them back is the whole point
  // of having the screen; it is idempotent (the setup write refuses a second
  // run) and terminates, because completing it flips the flag that got them here.
  if (!state.session.setupComplete) redirect('/onboarding/setup');

  // No `name` yet: there is no GET /me, so the heading stays un-personalised
  // rather than guessing one off an email. See EmptyPortal's header comment.
  return <EmptyPortal />;
}
