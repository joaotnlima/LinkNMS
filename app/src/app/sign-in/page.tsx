// Sign-in — Clerk (LINA-124, Auth Migration 0B); re-skinned to the D0 · Sign in
// artboard in LINA-191.
//
// ── WHAT THIS REPLACED ───────────────────────────────────────────────────────
// This page used to hold TWO doors, and both are gone:
//   * the magic-link request form (LINA-76 / ADR-0007), whose emailed one-time
//     token was consumed at /auth/callback to mint an `lnms_session` cookie; and
//   * the `LINKNMS_OPEN_SIGNIN=1` demo form, which traded an email for a session
//     with NO proof of control.
// Clerk owns the proof half now — email code or email link, its own delivery,
// its own single-use/expiry rules — so we no longer run an email-sending sign-in
// service, a token table, or a hand-rolled HMAC cookie. The demo door is not
// re-created behind a flag: a no-proof sign-in that exists anywhere eventually
// exists in production.
//
// The "check your email" state that `?sent=1` used to render is now inside
// Clerk's own component (routing="hash", so it stays on /sign-in), which is the
// same arrangement D0a-magic uses on /sign-up (LINA-131).
//
// ── LINA-191 ─────────────────────────────────────────────────────────────────
// The layout moved from a centred card on Paper to the split-screen `AuthShell`.
// Only the frame changed: the credential form is still Clerk's, hosted not
// rebuilt (LINA-129 §6).
'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';

import { AuthShell } from '@/components/AuthShell';
import { authShellAppearance } from '@/components/clerkAppearance';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

/**
 * Where to land after signing in. Same-origin PATHS only — an absolute or
 * protocol-relative `next` is ignored, so a crafted link cannot turn the sign-in
 * page into an open redirect. (The middleware only ever writes a path here, but
 * the value arrives from the URL, so it is re-checked rather than trusted.)
 */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

function SignInCard() {
  const next = safeNext(useSearchParams().get('next'));

  return (
    <div className="au-clerk">
      <SignIn
        routing="hash"
        signUpUrl="/sign-up"
        forceRedirectUrl={next}
        fallbackRedirectUrl={next}
        appearance={authShellAppearance}
      />
    </div>
  );
}

export default function SignInPage() {
  return (
    <AuthShell
      title="Sign in to LinkNMS"
      description="Welcome — choose how you'd like to continue."
      promise="One account for every build you're part of."
      promiseShort="One account for every build."
    >
      {PUBLISHABLE_KEY ? (
        // useSearchParams() forces a client render boundary; without the
        // Suspense wrapper the whole route opts out of static generation.
        <Suspense fallback={<div className="au-clerk" aria-busy="true" />}>
          <SignInCard />
        </Suspense>
      ) : (
        <section className="au-preview" role="note">
          <p>
            Authentication isn&rsquo;t configured in this environment yet. Once Clerk keys are
            provisioned, sign-in opens here.
          </p>
        </section>
      )}
    </AuthShell>
  );
}
