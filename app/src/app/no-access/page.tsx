// "You're signed in, but you don't have a seat yet" (LINA-124; ADR-0008).
//
// This state has always existed — the magic-link door simply never showed it:
// it declined silently, so an unseated address got a "check your email" screen
// and then nothing at all, forever. Clerk makes the gap visible, because Clerk
// will happily create a real account for someone who has no seat. That person is
// AUTHENTICATED and NOT ADMITTED, and the honest thing is to say so rather than
// bounce them back to a sign-in page that tells them they are already signed in.
//
// Deliberately says nothing about who else is or is not seated. Since LINA-189
// there IS a self-service path — claiming one of the fifty founding seats on the
// landing page — so the most likely reason to be here is no longer "your seat
// hasn't been granted yet" but "you signed up with a different address than the
// one you claimed with", or "you never claimed". Both are things the person can
// act on, so this page points at the claim rather than telling them to wait.
import { redirect } from 'next/navigation';

import { sessionState } from '@/server/session';
import { SignOutLink } from '@/components/SignOutLink';
// Moved here in LINA-191 with its last consumer: /sign-in and /sign-up left the
// `.ob-auth` centred-card layout for the split-screen AuthShell, so this
// stylesheet no longer belongs under sign-up/.
import './no-access.css';

export const dynamic = 'force-dynamic';

// The marketing site, where founding seats are claimed. Overridable so preview
// environments point at their own landing deployment rather than production.
const LANDING_URL = `${(process.env.NEXT_PUBLIC_LANDING_URL || 'https://linknms.com').replace(/\/$/, '')}/#pricing`;

export default async function NoAccessPage() {
  const state = await sessionState();
  // Only reachable in the one state it describes: a seated user belongs on the
  // record, and an anonymous one belongs at the front door.
  if (state.kind === 'party') redirect('/');
  if (state.kind === 'anonymous') redirect('/sign-in');

  return (
    <main className="ob-auth">
      <div className="ob-auth-head">
        <span className="ob-auth-brand">LinkNMS</span>
      </div>
      <section className="ob-auth-preview" role="note">
        <h1>Your seat isn&rsquo;t open yet</h1>
        <p>
          You&rsquo;re signed in as <strong>{state.email}</strong>, but this address doesn&rsquo;t
          have access to a shared record yet.
        </p>
        <p>
          LinkNMS is opening to a small first group of fifty founding owners. If you claimed a
          founding seat, check that you claimed it with <strong>this</strong> address — a seat is
          held for one inbox, and signing up with another lands you here.
        </p>
        <p>
          Haven&rsquo;t claimed one yet? <a href={LANDING_URL}>Claim a founding seat</a> — if any
          remain, you&rsquo;ll be back here in a minute with the door open.
        </p>
        <p>
          Signed in with the wrong address? <SignOutLink />
        </p>
      </section>
    </main>
  );
}
