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
// Why a client component: <SignUp/> from @clerk/clerk-react needs the browser
// Clerk context (<ClerkProvider> is wired in components/providers.tsx). We wrap
// it in the scoped .ob-auth onboarding palette so it matches D0a-setup.
'use client';

import { SignUp } from '@clerk/clerk-react';
import './sign-up.css';

// After a completed sign-up, land on the account-setup screen (D0a-setup) — a
// brand-new user has no display name or role yet, so the portal root is wrong.
const AFTER_SIGN_UP = '/onboarding/setup';

// Inlined at build by Next. Absent ⇒ render the preview notice instead of
// crashing, mirroring components/providers.tsx and the LINA-129 config: the app
// boots in preview mode when Clerk keys are not provisioned.
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

// Brand Clerk's prebuilt component with the onboarding tokens (Owner Blue, Ink,
// Paper, Inter) so the hosted form reads as LinkNMS, not stock Clerk.
const appearance = {
  variables: {
    colorPrimary: '#3e5c8a',
    colorText: '#16181d',
    colorTextSecondary: '#5c5f68',
    colorBackground: '#ffffff',
    colorInputText: '#16181d',
    colorInputBackground: '#fbfaf7',
    colorDanger: '#b4633b',
    fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
    borderRadius: '8px',
  },
  elements: {
    card: {
      border: '1px solid #e4e1d9',
      boxShadow: '0 1px 2px rgba(22,24,29,0.05), 0 12px 32px rgba(22,24,29,0.08)',
      borderRadius: '14px',
    },
    footerActionLink: { color: '#3e5c8a' },
  },
};

export default function SignUpPage() {
  return (
    <main className="ob-auth">
      <div className="ob-auth-head">
        <span className="ob-auth-brand">LinkNMS</span>
        <p className="ob-auth-sub">
          Create your account. Everything you record here is attributed to you by name and
          time-stamped — the shared record of what was agreed, what changed, and what it cost.
        </p>
      </div>

      {PUBLISHABLE_KEY ? (
        <div className="ob-auth-card">
          <SignUp
            routing="hash"
            signInUrl="/sign-in"
            forceRedirectUrl={AFTER_SIGN_UP}
            fallbackRedirectUrl={AFTER_SIGN_UP}
            appearance={appearance}
          />
        </div>
      ) : (
        <section className="ob-auth-preview" role="note">
          <h1>Sign-up isn&rsquo;t available in this preview</h1>
          <p>
            Authentication isn&rsquo;t configured in this environment yet. Once Clerk keys are
            provisioned, account creation opens here.
          </p>
          <p>
            Already have access? <a href="/sign-in">Sign in</a>.
          </p>
        </section>
      )}
    </main>
  );
}
