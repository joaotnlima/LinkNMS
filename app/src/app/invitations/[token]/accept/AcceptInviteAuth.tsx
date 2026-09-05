'use client';

// The signed-OUT half of M6/D6 — inline account creation on the invite deep link
// (LINA-179, ADR-0011 §6).
//
// WHY INLINE AND NOT A REDIRECT TO /sign-up. The invited contractor arrives from
// a WhatsApp message with one job: join this build. Bouncing them to a generic
// sign-up page, then to account setup, then hoping the token survived three
// navigations is where invites go to die — and a lost token here is not
// recoverable by the person holding it, only by the owner minting a new one.
// Clerk renders in place and force-redirects BACK to this exact URL, token and
// all, so the accept step is where they land the moment they have an identity.
//
// `routing="hash"` keeps Clerk's own multi-step flow (email → verification code)
// on this one route. Without it Clerk wants path segments under the mount point,
// which here would mean a catch-all route swallowing `[token]`.
//
// EMAIL PRE-FILL IS NOT WIRED, and that is a contract gap, not an omission. The
// issue asks for the email to be pre-filled from the invitation; doing that needs
// an UNAUTHENTICATED read of the invitation by token, and no such endpoint
// exists — `identity.invitation` is only ever read inside `acceptInvitation`,
// which requires a session. The alternative (putting the email in the link) would
// put a personal address in every message and URL bar the link is pasted into, to
// save one field. Flagged on LINA-179 for the Back-End/Architect; the screen is
// written so that a future `initialValues={{ emailAddress }}` is a one-line
// change here and nothing else.
import { SignUp } from '@clerk/nextjs';

import { clerkAppearance } from '@/components/clerkAppearance';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export function AcceptInviteAuth({ acceptPath }: { acceptPath: string }) {
  if (!PUBLISHABLE_KEY) {
    return (
      <section role="note">
        <p className="sub">
          Accounts aren&rsquo;t available in this preview environment yet. Keep this link — it stays
          valid until it is used.
        </p>
      </section>
    );
  }

  return (
    <div className="bw-accept-auth">
      <SignUp
        routing="hash"
        signInUrl={`/sign-in?next=${encodeURIComponent(acceptPath)}`}
        // Both, deliberately. `force` covers a completed sign-up; `fallback`
        // covers Clerk deciding the visitor already had a session. Either way the
        // next thing they see is this screen with a live session and the token
        // still in the path — which is the whole ADR-0011 §6 requirement.
        forceRedirectUrl={acceptPath}
        fallbackRedirectUrl={acceptPath}
        appearance={clerkAppearance}
      />
    </div>
  );
}
