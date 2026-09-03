'use client';

// D-4 waitlist email capture → D-3 confirmation (LINA-126; Onboarding Plan v4,
// Phase 1). Unauthenticated prospect capture: this posts straight to the portal's
// POST /api/waitlist (LINA-127), which owns no session by design.
//
// The service returns exactly three outcomes the UI cares about:
//   201            → new signup; show the D-3 "you're on the list" confirmation.
//   409 duplicate  → already on the list. Still a real person — show the SAME
//                    confirmation rather than an error, because "you're already
//                    saved" and "you're now saved" mean the same thing to them.
//   400 invalid_email → inline field error; keep what they typed.
// Anything else is an unexpected failure and gets a retryable generic message.
import { useState, type FormEvent } from 'react';
import { Mark } from '@/components/icons';

type State = 'idle' | 'submitting' | 'done' | 'error';

// A pragmatic client-side gate so an obviously malformed address never makes a
// round trip. The server's validator (including the disposable-domain blocklist)
// remains the authority — this only saves a request and gives instant feedback.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WaitlistForm() {
  const [state, setState] = useState<State>('idle');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setError('Enter a valid email address.');
      return;
    }
    setError(null);
    setState('submitting');

    // Where the signup came from — retained for analytics, never part of dedupe.
    const referrer = typeof document !== 'undefined' ? document.referrer : '';
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: value,
          source: 'portal-waitlist',
          ...(referrer ? { referrer: referrer.slice(0, 500) } : {}),
        }),
      });

      // 201 new, 409 already-on-list — both land the person on the confirmation.
      if (res.status === 201 || res.status === 409) {
        setState('done');
        return;
      }

      if (res.status === 400) {
        const body = await res.json().catch(() => null);
        setError(
          body?.error?.code === 'invalid_email'
            ? 'That email doesn’t look right. Check it and try again.'
            : 'We couldn’t accept that. Check your details and try again.',
        );
        setState('idle');
        return;
      }

      setState('error');
    } catch {
      setState('error');
    }
  }

  if (state === 'done') {
    return (
      <div className="wl__inner" role="status">
        <span className="wl__brand">
          <Mark className="wl__mk" />
          LinkNMS
        </span>

        <div className="wl__check" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>

        <p className="wl__eyebrow">You&rsquo;re on the list</p>
        <h1 className="wl__title">Your spot is saved.</h1>
        <p className="wl__sub">
          We&rsquo;ll email your invite when we open the doors — one link drops you straight into your
          first build.
        </p>

        <div className="wl__launch">
          <span className="wl__launch-lbl">We launch</span>
          <span className="wl__launch-date">1 October</span>
        </div>

        <ol className="wl__steps">
          <li className="wl__step">
            <span className="wl__step-num">1</span>
            <span className="wl__step-txt">
              <b>We save your place in the queue.</b> Waitlist members get in before the public launch
              — no extra step needed.
            </span>
          </li>
          <li className="wl__step">
            <span className="wl__step-num">2</span>
            <span className="wl__step-txt">
              <b>On 1 October, we email your invite.</b> A single link opens your first project. Bring
              a real schedule.
            </span>
          </li>
          <li className="wl__step">
            <span className="wl__step-num">3</span>
            <span className="wl__step-txt">
              <b>We colour in your build.</b> Import your plan and watch it become blue, orange and
              green on one live timeline.
            </span>
          </li>
        </ol>
      </div>
    );
  }

  return (
    <div className="wl__inner">
      <span className="wl__brand">
        <Mark className="wl__mk" />
        LinkNMS
      </span>

      <p className="wl__eyebrow">Early access</p>
      <h1 className="wl__title">One shared timeline for every build.</h1>
      <p className="wl__sub">
        The plan in blue, changes in orange, closed work in green — one record of what was agreed,
        what changed, and what it cost. Reserve your seat.
      </p>

      <span className="wl__swatches" aria-hidden="true">
        <span className="wl__swatch wl__swatch--blue" />
        <span className="wl__swatch wl__swatch--orange" />
        <span className="wl__swatch wl__swatch--green" />
      </span>

      <form className="wl__form" onSubmit={onSubmit} noValidate>
        <div className="wl__field">
          <label className="wl__label" htmlFor="wl-email">
            Email
          </label>
          <input
            id="wl-email"
            className="wl__input"
            type="email"
            name="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.currentTarget.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'wl-email-error' : undefined}
            disabled={state === 'submitting'}
            required
          />
        </div>

        {error && (
          <p className="wl__error" id="wl-email-error" role="alert">
            <span aria-hidden="true">⚠</span> {error}
          </p>
        )}

        {state === 'error' && (
          <p className="wl__error" role="alert">
            <span aria-hidden="true">⚠</span> Something went wrong on our end. Please try again.
          </p>
        )}

        <button className="wl__btn" type="submit" disabled={state === 'submitting'}>
          {state === 'submitting' ? 'Reserving…' : 'Reserve my seat'}
        </button>

        <p className="wl__note">
          We&rsquo;ll only email you about early access. No spam, unsubscribe anytime.
        </p>
      </form>
    </div>
  );
}
