// D0a-setup — account setup / profile screen, shown once on first login
// (LINA-132, part of the LINA-118 onboarding plan, Phase 2 Auth & Activation).
//
// It collects the three things the RBAC model needs before a user has a place in
// a record: how they should APPEAR (display name), WHAT they are (Owner vs GC —
// a choice only; the entitlement is granted server-side), and the LANGUAGE the
// portal should speak to them. It POSTs them to /api/me/profile (LINA-137) with a
// Clerk session token, then hands off to the first-time empty portal (D1-new).
//
// Why a client component: the Clerk session token lives in the browser
// (@clerk/nextjs), so the authenticated POST is made here, not in a server
// action. The screen re-checks it has a live Clerk session and bounces to
// sign-in if not — the server re-verifies regardless (identity comes from the
// token, never trust the client), this is only a courtesy redirect.
'use client';

import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth, useUser } from '@clerk/nextjs';

import { submitProfile, type Language, type ProfileInput, type Role } from '@/lib/profile';
import './onboarding-setup.css';

// Where a completed setup lands: the first-time empty portal state (D1-new).
const PORTAL_HOME = '/';

// Inlined at build by Next. Absent ⇒ render the preview notice instead of
// mounting the Clerk-hook body, which would otherwise crash the static prerender
// with "useAuth can only be used within <ClerkProvider/>" when no key is
// provisioned. Mirrors sign-up/page.tsx and components/providers.tsx: the app
// boots in preview mode when Clerk keys are absent, and builds without them.
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const ROLES: { value: Role; label: string; blurb: string; accent: 'owner' | 'builder' }[] = [
  {
    value: 'owner',
    label: 'Owner',
    blurb: 'You are having the house built. You set the baseline and approve what moves it.',
    accent: 'owner',
  },
  {
    value: 'general_contractor',
    label: 'General contractor',
    blurb: 'You run the build. You propose changes and record what was done and what it cost.',
    accent: 'builder',
  },
];

const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'pt', label: 'Português' },
  { value: 'es', label: 'Español' },
];

// Default export: gate the Clerk-hook body behind the publishable key so the
// page prerenders in preview / keyless CI builds. When the key is present (all
// real environments, incl. Vercel) this renders <AccountSetupForm/> exactly as
// before, inside the <ClerkProvider> wired in components/providers.tsx.
export default function AccountSetupPage() {
  if (!PUBLISHABLE_KEY) {
    return (
      <main className="ob" role="note">
        <div className="ob-card">
          <header className="ob-head">
            <span className="ob-brand">LinkNMS</span>
            <h1 className="ob-title">Account setup isn&rsquo;t available in this preview</h1>
            <p className="ob-sub">
              Authentication isn&rsquo;t configured in this environment yet. Once Clerk keys are
              provisioned, account setup opens here after you sign up.
            </p>
          </header>
        </div>
      </main>
    );
  }
  // useSearchParams() needs a Suspense boundary or Next refuses to prerender
  // this route at build time.
  return (
    <Suspense fallback={null}>
      <AccountSetupForm />
    </Suspense>
  );
}

/**
 * The role to preselect, from the persona carried across the claim (LINA-189).
 *
 * The visitor pressed a CTA on the Owner or the Builder side of the landing
 * page's pricing split, so we already know which of the two they are. Asking
 * again — after they claimed a seat, confirmed an inbox and created an account
 * — is asking someone to repeat themselves.
 *
 * A PRESELECTION, not a decision: the radio group is fully interactive and the
 * choice they submit is whatever is selected when they press the button. The
 * server validates the role it receives and, either way, the role is a label on
 * their own party — access to any build is membership (ADR-0004), so this
 * parameter cannot grant anything to anyone.
 */
function personaRole(raw: string | null): Role | null {
  if (raw === 'owner') return 'owner';
  if (raw === 'builder') return 'general_contractor';
  return null;
}

function AccountSetupForm() {
  const router = useRouter();
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const { user } = useUser();
  const searchParams = useSearchParams();

  // Seed the display name from Clerk once the user is known — most people keep
  // it, and an empty box on a first-run screen reads as a chore.
  const suggestedName = useMemo(
    () => user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? '',
    [user],
  );

  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role | null>(personaRole(searchParams.get('persona')));
  const [language, setLanguage] = useState<Language>('en');

  const [fieldError, setFieldError] = useState<{ field: keyof ProfileInput; message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The name the field shows: what they typed, else the Clerk suggestion.
  const nameValue = displayName || suggestedName;

  if (!isLoaded) {
    return (
      <main className="ob" aria-busy="true">
        <div className="ob-card">
          <p className="ob-sub">Loading…</p>
        </div>
      </main>
    );
  }

  if (!isSignedIn) {
    // No live Clerk session — nothing to set up. Send them to sign in.
    router.replace('/sign-in');
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setFieldError(null);
    setFormError(null);

    const name = nameValue.trim();
    if (!name) {
      setFieldError({ field: 'displayName', message: 'Tell us how you should appear on the record.' });
      return;
    }
    if (!role) {
      setFieldError({ field: 'role', message: 'Choose the role that fits you on this build.' });
      return;
    }

    setSubmitting(true);
    try {
      const token = await getToken();
      if (!token) {
        // Session evaporated between load and submit — treat as signed out.
        await signOut();
        router.replace('/sign-in');
        return;
      }

      const result = await submitProfile(token, { displayName: name, role, language });
      switch (result.kind) {
        case 'ok':
          router.replace(PORTAL_HOME);
          return;
        case 'field':
          setFieldError({ field: result.field, message: result.message });
          return;
        case 'unauthenticated':
          await signOut();
          router.replace('/sign-in');
          return;
        case 'retry':
        case 'error':
          setFormError(result.message);
          return;
      }
    } catch {
      setFormError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const nameError = fieldError?.field === 'displayName' ? fieldError.message : null;
  const roleError = fieldError?.field === 'role' ? fieldError.message : null;
  const langError = fieldError?.field === 'language' ? fieldError.message : null;

  return (
    <main className="ob">
      <form className="ob-card" onSubmit={onSubmit} noValidate>
        <header className="ob-head">
          <span className="ob-brand">LinkNMS</span>
          <h1 className="ob-title">Set up your account</h1>
          <p className="ob-sub">
            This is how you appear on every decision you make — attributable and time-stamped. You
            can change it later in settings.
          </p>
        </header>

        {formError ? (
          <p className="ob-alert" role="alert">
            <span aria-hidden="true">⚠ </span>
            {formError}
          </p>
        ) : null}

        {/* Display name */}
        <label className="ob-field">
          <span className="ob-label">Display name</span>
          <input
            name="displayName"
            type="text"
            autoComplete="name"
            maxLength={200}
            value={nameValue}
            onChange={(e) => setDisplayName(e.target.value)}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'name-err' : 'name-help'}
            placeholder="How you should appear on the record"
          />
          {nameError ? (
            <span id="name-err" className="ob-fielderr" role="alert">
              {nameError}
            </span>
          ) : (
            <span id="name-help" className="ob-help">
              Shown beside every decision, change, and cost you record.
            </span>
          )}
        </label>

        {/* Role */}
        <fieldset className="ob-field ob-roles" aria-describedby={roleError ? 'role-err' : undefined}>
          <legend className="ob-label">Your role on the build</legend>
          <div className="ob-rolegrid" role="radiogroup" aria-label="Your role on the build">
            {ROLES.map((r) => (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={role === r.value}
                className={`ob-role ob-role--${r.accent}${role === r.value ? ' is-selected' : ''}`}
                onClick={() => setRole(r.value)}
              >
                <span className="ob-role-name">{r.label}</span>
                <span className="ob-role-blurb">{r.blurb}</span>
              </button>
            ))}
          </div>
          {roleError ? (
            <span id="role-err" className="ob-fielderr" role="alert">
              {roleError}
            </span>
          ) : null}
        </fieldset>

        {/* Language */}
        <label className="ob-field">
          <span className="ob-label">Language</span>
          <select
            name="language"
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            aria-invalid={langError ? true : undefined}
            aria-describedby={langError ? 'lang-err' : undefined}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          {langError ? (
            <span id="lang-err" className="ob-fielderr" role="alert">
              {langError}
            </span>
          ) : null}
        </label>

        <button type="submit" className="ob-submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Setting up…' : 'Continue to your portal'}
        </button>
      </form>
    </main>
  );
}
