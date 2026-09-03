// Home — the entry into a shared record (LINA-57).
//
// This page used to redirect straight to a hard-coded DEMO_PROJECT_ID, which was
// the right shape while the data was a fixture and the wrong one the moment it
// became real. It is now the FR1 doorway: sign in, then either start a record or
// join one you were invited to.
//
// KNOWN GAP, stated rather than papered over: R0 has no "list my projects"
// endpoint, so a returning owner reaches their record by its URL. Adding
// GET /projects would be a small Identity change; it is deliberately NOT
// smuggled in here as a client-side list of remembered ids, which would be a
// second, un-authorized source of truth about who is on what.
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { TopBar } from '@/components/chrome';
import { Mark } from '@/components/icons';
import { sessionState } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // Three states, three answers (LINA-124). An unseated visitor is signed in —
  // bouncing them to /sign-in would loop them through a page telling them they
  // already are — so they get the honest "no seat yet" screen instead.
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in');
  if (state.kind === 'unseated') redirect('/no-access');

  return (
    <>
      <TopBar />
      <main className="screen">
        <div>
          <div className="crumbs">
            <Mark className="mk" /> LinkNMS
          </div>
          <h1 className="scr">One shared record</h1>
          <p className="sub">
            What was agreed, what changed, and what it cost — attributable and time-stamped.
          </p>
        </div>

        <section className="card">
          <Link className="row" href="/projects/new">
            <span style={{ fontWeight: 600 }}>🏗️ Start a project</span>
            <span className="cap">set the baseline budget →</span>
          </Link>
          <Link className="row" href="/invitations/accept">
            <span style={{ fontWeight: 600 }}>🔑 Join with an invitation</span>
            <span className="cap">paste your invite code →</span>
          </Link>
        </section>

        <p className="cap">
          Already on a record? Open it by its link — every project has a permanent URL.
        </p>
      </main>
    </>
  );
}
