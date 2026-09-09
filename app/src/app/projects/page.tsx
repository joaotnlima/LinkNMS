// /projects — the portfolio route (LINA-219 follow-up).
//
// The app's "Builds" controls (the record home's back-link and the M14 tab bar,
// see components/chrome.tsx) point here, and so may a bookmark or a typed URL.
// The portfolio itself is rendered by the root route `/` — it is the FR1 doorway
// that also owns the anonymous / unseated / not-set-up branches (see app/page.tsx),
// so there is one authority on "what does a signed-in visitor see", not two.
//
// Before this file existed, `/projects` had no page: tapping *Builds* from a
// build's record landed on the error boundary ("This record could not be
// loaded") and the owner never reached their build list. This makes the route
// resolve to the real portfolio.
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function ProjectsIndex() {
  redirect('/');
}
