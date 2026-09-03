// Sign-in — Clerk (LINA-124, Auth Migration 0B).
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
'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';

import { clerkAppearance } from '@/components/clerkAppearance';
// The onboarding palette, shared with D0a so the two doors look like one system.
import '../sign-up/sign-up.css';

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
    <div className="ob-auth-card">
      <SignIn
        routing="hash"
        signUpUrl="/sign-up"
        forceRedirectUrl={next}
        fallbackRedirectUrl={next}
        appearance={clerkAppearance}
      />
    </div>
  );
}

export default function SignInPage() {
  return (
    <main className="ob-auth">
      <div className="ob-auth-head">
        <span className="ob-auth-brand">LinkNMS</span>
        <p className="ob-auth-sub">
          Sign in to the shared record. Everything you record here is attributed to you by name and
          time-stamped.
        </p>
      </div>

      {PUBLISHABLE_KEY ? (
        // useSearchParams() forces a client render boundary; without the
        // Suspense wrapper the whole route opts out of static generation.
        <Suspense fallback={<div className="ob-auth-card" aria-busy="true" />}>
          <SignInCard />
        </Suspense>
      ) : (
        <section className="ob-auth-preview" role="note">
          <h1>Sign-in isn&rsquo;t available in this preview</h1>
          <p>
            Authentication isn&rsquo;t configured in this environment yet. Once Clerk keys are
            provisioned, sign-in opens here.
          </p>
        </section>
      )}
    </main>
  );
}
