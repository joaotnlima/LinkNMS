// Home — the portal root.
//
// This page used to redirect straight to a hard-coded DEMO_PROJECT_ID, which was
// the right shape while the data was a fixture and the wrong one the moment it
// became real. It became the FR1 doorway in LINA-57, and is now the D1-new
// first-time empty portal state (LINA-133): the screen onboarding/setup
// (LINA-132) hands off to once a profile is complete.
//
// KNOWN GAP, stated rather than papered over — and the reason this route can
// branch here between <EmptyPortal/> and a portfolio list. That endpoint landed
// (GET /api/v1/projects, LINA-197), so this route now makes the call and shows
// the list when it comes back non-empty. The list is membership-scoped
// server-side (the session, never a client-held set of remembered ids), so
// there is still only one authorized source of truth about who is on what.
import { redirect } from 'next/navigation';
import { EmptyPortal } from '@/components/EmptyPortal';
import { PortfolioList } from '@/components/PortfolioList';
import { listProjects } from '@/lib/api';
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

  // Seated and set up: branch on the portfolio. Empty keeps the first-time
  // screen verbatim (LINA-133); non-empty renders the D1 list. Drafts count as
  // builds — an abandoned wizard is a build in progress, and the list is where
  // it is resumed from.
  const projects = await listProjects();
  if (projects.length === 0) return <EmptyPortal />;
  return <PortfolioList projects={projects} />;
}
