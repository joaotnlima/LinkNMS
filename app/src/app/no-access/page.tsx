// "You're signed in, but you don't have a seat yet" (LINA-124; ADR-0008).
//
// This state has always existed — the magic-link door simply never showed it:
// it declined silently, so an unseated address got a "check your email" screen
// and then nothing at all, forever. Clerk makes the gap visible, because Clerk
// will happily create a real account for someone who has no seat. That person is
// AUTHENTICATED and NOT ADMITTED, and the honest thing is to say so rather than
// bounce them back to a sign-in page that tells them they are already signed in.
//
// Deliberately says nothing about who else is or is not seated, and offers no
// self-service path: the first ten seats are granted by hand
// (scripts/grant-seat.mjs), and this page is the waiting room for that.
import { redirect } from 'next/navigation';

import { sessionState } from '@/server/session';
import { SignOutLink } from '@/components/SignOutLink';
import '../sign-up/sign-up.css';

export const dynamic = 'force-dynamic';

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
          LinkNMS is opening to a small first group. If you joined the waitlist, you&rsquo;ll get an
          email the day your seat opens — nothing else is needed from you.
        </p>
        <p>
          Signed in with the wrong address? <SignOutLink />
        </p>
      </section>
    </main>
  );
}
