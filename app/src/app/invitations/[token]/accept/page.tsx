// M6/D6 — the invite deep link (LINA-179, ADR-0011 §6).
//
// Pen source: Bootstrap Flow Board, screen 06 ("GC accepts invite").
//
// This is the ONE screen in Band B a signed-out person sees, and the only one
// reached from outside the app — the owner pastes this URL into WhatsApp or it
// arrives by email. Everything about it follows from that:
//
//   * It renders for anonymous visitors. `/invitations(.*)` is otherwise a
//     protected route; middleware.ts now excludes exactly this path so the
//     visitor gets the landing with inline sign-up instead of a bounce to
//     /sign-in that strips the token. The exclusion grants NOTHING: acceptance
//     still requires a live session below, and the service re-verifies.
//   * Accepting is a POST, never a GET. A link the contractor merely opens —
//     or that a mail scanner prefetches — must not put them on someone's record.
//     Hence a real form with a submit, not an auto-accept on load.
//   * The token stays in the PATH across the whole auth round trip, so Clerk's
//     redirect back lands here with it intact.
//
// WHAT THE PEN ASKS FOR AND THIS CANNOT SHOW: screen 06 draws the build name, the
// owner and the scope note on the landing. All three need an unauthenticated read
// of the invitation by token, and no such endpoint exists (see the note in
// AcceptInviteAuth). Rather than invent a build name, the screen is honest about
// what it knows: someone invited you, here is what accepting means. Flagged on
// LINA-179 for the Back-End/Architect — a `GET /invitations/:token` preview
// endpoint returning `{ projectName, ownerName, role }` and nothing sensitive is
// the change that completes this screen.
import Link from 'next/link';

import { ActionForm } from '@/components/ActionForm';
import { acceptInviteAction } from '@/app/actions';
import { isSignedIn } from '@/lib/api';
import { AcceptInviteAuth } from './AcceptInviteAuth';
import '../../../build-wizard.css';

export const dynamic = 'force-dynamic';

export default async function AcceptDeepLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const acceptPath = `/invitations/${encodeURIComponent(token)}/accept`;
  const signedIn = await isSignedIn();

  return (
    <main className="bw-accept">
      <section className="bw-accept-card">
        <span className="bw-accept-brand">LinkNMS</span>
        <h1 className="bw-accept-title">You have been invited to a build</h1>
        <p className="sub">
          LinkNMS is the shared record of a build: what was agreed, what changed, and what it cost.
          When you join, everything either party records is attributed by name and time-stamped —
          and neither of you can quietly rewrite it later.
        </p>

        {signedIn ? (
          <>
            <ActionForm
              action={acceptInviteAction}
              submitLabel="Accept and join the build"
              pendingLabel="Joining…"
            >
              {/* The token proves the invitation; the SESSION says who is
                  joining (ADR-0004). A token alone can never put an
                  unauthenticated stranger on a record. */}
              <input type="hidden" name="token" value={token} />
            </ActionForm>
            <p className="cap">
              Joining as someone else?{' '}
              <Link href={`/sign-in?next=${encodeURIComponent(acceptPath)}`}>
                Sign in with a different account
              </Link>{' '}
              and open this link again.
            </p>
          </>
        ) : (
          <>
            <p className="cap">
              Create your account to accept. It takes a moment and you come straight back here —
              your invitation is held.
            </p>
            <AcceptInviteAuth acceptPath={acceptPath} />
            <p className="cap">
              Already have an account?{' '}
              <Link href={`/sign-in?next=${encodeURIComponent(acceptPath)}`}>Sign in</Link> and this
              link will pick up where it left off.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
