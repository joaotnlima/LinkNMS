// D0a — account-creation / sign-up screen + D0a-magic "check your email" state
// (LINA-131, part of the LINA-118 onboarding plan, Phase 2 Auth & Activation).
//
// The credential form itself is Clerk's prebuilt <SignUp/>. Per the Clerk
// Integration spec (LINA-129 §6) we consume the publishable key and the hosted
// component; we do NOT build a custom email/password form. Clerk owns both:
//   * D0a       — the account-creation form (email + verification), and
//   * D0a-magic — the "check your email" verification step, rendered inline via
//                 routing="hash" so both states live on /sign-up (no second route).
// On success Clerk force-redirects to /onboarding/setup (D0a-setup, LINA-132),
// where the new user picks a display name + role before entering any record.
//
// Why a client component: <SignUp/> from @clerk/nextjs needs the browser
// Clerk context (<ClerkProvider> is wired in components/providers.tsx).
//
// LINA-191: the frame is now the shared split-screen `AuthShell`, the same one
// /sign-in renders. The pen draws one Band A · Account artboard, not two — the
// two doors are the same screen with a different verb, and keeping them in one
// component is what stops the sign-in door and the sign-up door from drifting
// into looking like different products (the LINA-124 note above, made
// structural rather than a convention).
'use client';

import { Suspense } from 'react';
import { SignUp } from '@clerk/nextjs';
import { useSearchParams } from 'next/navigation';

import { AuthShell } from '@/components/AuthShell';
import { authShellAppearance } from '@/components/clerkAppearance';

// After a completed sign-up, land on the account-setup screen (D0a-setup) — a
// brand-new user has no display name or role yet, so the portal root is wrong.
const AFTER_SIGN_UP = '/onboarding/setup';

// Inlined at build by Next. Absent ⇒ render the preview notice instead of
// crashing, mirroring components/providers.tsx and the LINA-129 config: the app
// boots in preview mode when Clerk keys are not provisioned.
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

/**
 * The address to prefill, when the visitor arrived from a founding-seat claim
 * (LINA-189: /api/confirm redirects here with `?email=`).
 *
 * This is convenience, not authorisation — the seat gate keys on the address
 * Clerk VERIFIES, so a hand-edited parameter changes a form field and nothing
 * else. What it prevents is the ordinary way the loop breaks: someone claims a
 * seat with one address, then signs up with another and lands on /no-access
 * holding a seat that is waiting for a different inbox.
 */
function useClaimedEmail(): string | undefined {
  const raw = useSearchParams().get('email')?.trim().toLowerCase();
  return raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : undefined;
}

/**
 * The persona the claim came in as — 'owner' or 'builder' (LINA-189).
 *
 * The landing page already knows which of the two the visitor is, because they
 * pressed a CTA on one side of the Owner/Builder pricing split. Carrying it
 * across the hand-off lets account setup preselect their role instead of asking
 * them to restate, a minute later, something they already chose.
 *
 * Whitelisted to the two known values, so nothing arbitrary reaches the next
 * screen. Like `email` it is a PREFILL: it selects a radio button on a form the
 * person still submits themselves, and the role it selects is a label on their
 * own party that grants access to no build (ADR-0004 — access is membership).
 */
function useClaimedPersona(): 'owner' | 'builder' | undefined {
  const raw = useSearchParams().get('persona')?.trim().toLowerCase();
  return raw === 'owner' || raw === 'builder' ? raw : undefined;
}

function ClerkSignUp() {
  const emailAddress = useClaimedEmail();
  const persona = useClaimedPersona();
  // Clerk owns the redirect after sign-up, so the persona has to ride in the
  // destination URL — there is no other channel from here to the next screen.
  const afterSignUp = persona ? `${AFTER_SIGN_UP}?persona=${persona}` : AFTER_SIGN_UP;
  return (
    <SignUp
      routing="hash"
      signInUrl="/sign-in"
      forceRedirectUrl={afterSignUp}
      fallbackRedirectUrl={afterSignUp}
      initialValues={emailAddress ? { emailAddress } : undefined}
      appearance={authShellAppearance}
    />
  );
}

export default function SignUpPage() {
  return (
    <AuthShell
      title="Create your LinkNMS account"
      // Deliberately the same welcome line as /sign-in: at this point the
      // visitor has not chosen a method yet, and the choice is identical on
      // both doors.
      description="Welcome — choose how you'd like to continue."
      promise="One account for every build you're part of."
      promiseShort="One account for every build."
    >
      {PUBLISHABLE_KEY ? (
        <div className="au-clerk">
          {/* useSearchParams() needs a boundary: without one Next refuses to
              prerender this route at build time. */}
          <Suspense fallback={null}>
            <ClerkSignUp />
          </Suspense>
        </div>
      ) : (
        <section className="au-preview" role="note">
          <p>
            Authentication isn&rsquo;t configured in this environment yet. Once Clerk keys are
            provisioned, account creation opens here.
          </p>
          <p>
            Already have access? <a href="/sign-in">Sign in</a>.
          </p>
        </section>
      )}
    </AuthShell>
  );
}
