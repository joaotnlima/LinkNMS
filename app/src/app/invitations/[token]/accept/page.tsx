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
// WHAT THE PEN DRAWS AND THIS NOW SHOWS (LINA-198): screen 06 draws the build
// name, the owner and the role on the landing. The unauthenticated preview read
// those need — `GET /invitations/:token` returning `{ projectName, invitedByName,
// role }` and nothing sensitive — landed in LINA-182, so this screen fetches it
// and renders build/owner/role above the CTA. The scope note is still absent:
// the invitation carries no note column (see build-creation.ts GAPS), so there
// is nothing to show; when that column exists it belongs here.
import Link from 'next/link';

import { ActionForm } from '@/components/ActionForm';
import { acceptInviteAction } from '@/app/actions';
import { isSignedIn, getInvitationPreview } from '@/lib/api';
import { roleLabel } from '@/lib/format';
import { AcceptInviteAuth } from './AcceptInviteAuth';
import '../../../build-wizard.css';

export const dynamic = 'force-dynamic';

export default async function AcceptDeepLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const acceptPath = `/invitations/${encodeURIComponent(token)}/accept`;
  const signedIn = await isSignedIn();

  // D6 — show what you're joining (LINA-198). The preview endpoint now exists
  // (GET /invitations/:token, LINA-182), so the screen no longer has to be
  // vague about the build. Unknown/spent tokens are a 404 and rate-limiting is a
  // 429; either way we fall back to the generic copy rather than 500 the page —
  // the accept POST below re-verifies the token regardless.
  const preview = await getInvitationPreview(token).catch(() => null);
  const buildName = preview?.projectName?.trim() || null;
  const ownerName = preview?.invitedByName?.trim() || null;

  return (
    <main className="bw-accept">
      <section className="bw-accept-card">
        <span className="bw-accept-brand">LinkNMS</span>
        <h1 className="bw-accept-title">
          {buildName ? (
            <>
              You&rsquo;ve been invited to <span className="bw-invite-name">{buildName}</span>
            </>
          ) : (
            'You have been invited to a build'
          )}
        </h1>
        <p className="sub">
          LinkNMS is the shared record of a build: what was agreed, what changed, and what it cost.
          When you join, everything either party records is attributed by name and time-stamped —
          and neither of you can quietly rewrite it later.
        </p>

        {/* D6 — what you're joining. Only rendered when the token previews; the
            role is always known for a real invitation, name/owner may be null
            while the store has no display name yet. */}
        {preview && (
          <dl className="bw-invite-preview">
            {buildName && (
              <div className="bw-invite-row">
                <dt>Build</dt>
                <dd>{buildName}</dd>
              </div>
            )}
            {ownerName && (
              <div className="bw-invite-row">
                <dt>Invited by</dt>
                <dd>{ownerName}</dd>
              </div>
            )}
            <div className="bw-invite-row">
              <dt>Your role</dt>
              <dd>
                <span className={`tag ${preview.role}`}>
                  <span className="pd" />
                  {roleLabel(preview.role)}
                </span>
              </dd>
            </div>
          </dl>
        )}

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

        {/* Decline is a plain way out, not a state change: nothing is recorded
            until the visitor accepts, so "not now" is just leaving. */}
        <p className="cap bw-invite-decline">
          <Link href="/">Not now — this isn&rsquo;t for me</Link>
        </p>
      </section>
    </main>
  );
}
