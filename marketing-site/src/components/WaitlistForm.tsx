'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { identifyByEmail, track } from '@/lib/analytics-client';
import { normalizeEmail } from '@/lib/email-normalize';

type State = 'idle' | 'submitting' | 'success' | 'dup' | 'error';

// Cloudflare Turnstile explicit-render API. Loaded once and shared across every
// WaitlistForm instance on the page (header, hero, final CTA).
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
  }
}

let turnstileReady: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (turnstileReady) return turnstileReady;
  turnstileReady = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('turnstile load failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('turnstile load failed'));
    document.head.appendChild(s);
  });
  return turnstileReady;
}

// Waitlist capture with double opt-in: POST /api/waitlist inserts 'unconfirmed'
// and sends a tokenized confirmation email. Honeypot + Turnstile token are posted
// for the server-side spam checks. The Turnstile widget injects a hidden
// `cf-turnstile-response` input into the form, which we forward as turnstileToken.
// Read the true acquisition context in the browser: a utm_source query param
// wins, otherwise an external referring host, otherwise the server-provided
// default. The raw referrer is sent alongside so the DB records where the
// visitor actually came from (e.g. linknms.com) instead of a hardcoded guess.
function acquisition(fallbackSource: string): { source: string; referrer: string } {
  if (typeof window === 'undefined') return { source: fallbackSource, referrer: '' };
  const referrer = document.referrer || '';
  const utmSource = new URLSearchParams(window.location.search).get('utm_source');
  let refHost = '';
  try {
    refHost = referrer ? new URL(referrer).hostname : '';
  } catch {
    /* malformed referrer — ignore */
  }
  const external = refHost && refHost !== window.location.hostname ? refHost : '';
  const source = utmSource || external || fallbackSource;
  return { source: source.slice(0, 120), referrer };
}

// The form has one presentation, because the landing page is the only page
// that renders it. There is one submit path, one spam path and one analytics
// path.
//
// §6 Q5 (founder, 2026-08-29): "Keep role as a second step after email. The CTA
// form shows email first; role appears after email is entered." So the select
// stays hidden until the email field has something in it — the design's
// single-field ask is what the visitor sees, and role is asked only once they
// have already committed to answering.
//
// The placeholder option below is the analytics review's one non-negotiable
// (`landing-event-map-v2` §3.7): the old form preselected `homeowner`, so a
// submitter who ignored the dropdown was indistinguishable from one who chose
// it, and every role we have ever collected is suspect. An empty first option
// makes "did not answer" a distinct, honest value.
export function WaitlistForm({ source }: { source: string }) {
  const t = useTranslations('waitlist');
  const locale = useLocale();
  const [state, setState] = useState<State>('idle');
  // `roleOptions` is an ordered { key: label } map — value is the stable enum key
  // (shared with the server), the label is the localized display text.
  const roleOptions = Object.entries(t.raw('roleOptions') as Record<string, string>);

  // Site key is public and inlined at build time. When unset (local dev) the
  // widget is skipped and the server, lacking a secret, skips verification too.
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // form_start fires once per mount, on the first focus of the email field.
  const startedRef = useRef(false);
  // The role step unlocks once an email has been typed.
  const [emailEntered, setEmailEntered] = useState(false);

  const onEmailFocus = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    track('form_start', { form_location: source });
  };

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !widgetRef.current || !window.turnstile) return;
        if (widgetIdRef.current !== null) return; // already rendered
        widgetIdRef.current = window.turnstile.render(widgetRef.current, {
          sitekey: siteKey,
          action: 'waitlist'
        });
      })
      .catch(() => {
        /* network/adblock — server still enforces; leave token empty */
      });
    return () => {
      cancelled = true;
      if (widgetIdRef.current !== null && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* noop */
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') || '');
    setState('submitting');
    const { source: effectiveSource, referrer } = acquisition(source);
    const honeypot = String(data.get('company') || '').trim();
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          role: String(data.get('role') || ''), // stable enum key
          // Honeypot: only sent when actually filled (i.e. by a bot). Real
          // submissions omit it entirely rather than posting an empty field.
          ...(honeypot ? { company: honeypot } : {}),
          turnstileToken: String(data.get('cf-turnstile-response') || ''),
          locale,
          source: effectiveSource,
          referrer
        })
      });
      if (res.status === 409) {
        // Known email — still a real person; join their session to the
        // server-side conversion events keyed on the normalized email.
        identifyByEmail(normalizeEmail(email));
        setState('dup');
      } else if (res.ok) {
        // Join this anonymous session to the server-side `waitlist_submitted` /
        // `waitlist_verified` events (both keyed on the normalized email) so the
        // funnel reconciles across client + server. We do NOT re-fire the submit
        // event here — the server owns it.
        identifyByEmail(normalizeEmail(email));
        setState('success');
        form.reset();
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    } finally {
      // Turnstile tokens are single-use — reset so a retry gets a fresh one.
      if (widgetIdRef.current !== null && window.turnstile) {
        try {
          window.turnstile.reset(widgetIdRef.current);
        } catch {
          /* noop */
        }
      }
    }
  }

  if (state === 'success' || state === 'dup') {
    return (
      <div className="lp-form__msg" role="status">
        <p className="mt">{t('successTitle')}</p>
        <p className="mb">{state === 'dup' ? t('errorDup') : t('successBody')}</p>
      </div>
    );
  }

  return (
    <>
      <form className="lp-form" onSubmit={onSubmit} noValidate>
        <div className="inp">
          <label className="lp-micro" htmlFor="email">
            {t('email')}
          </label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder={t('emailPh')}
            required
            autoComplete="email"
            onFocus={onEmailFocus}
            onChange={(e) => setEmailEntered(e.currentTarget.value.trim().length > 0)}
          />
        </div>
        {emailEntered && (
          <div className="inp">
            <label className="lp-micro" htmlFor="role">
              {t('role')}
            </label>
            <select id="role" name="role" defaultValue="">
              {/* Empty placeholder — "did not answer" must be its own value. */}
              <option value="">{t('rolePlaceholder')}</option>
              {roleOptions.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* Honeypot — real users never fill this */}
        <div className="hp" aria-hidden="true">
          <label htmlFor="company">Company</label>
          <input id="company" name="company" type="text" tabIndex={-1} autoComplete="off" />
        </div>
        {siteKey && <div ref={widgetRef} className="cf-turnstile-widget" />}
        <button className="lp-btn" type="submit" disabled={state === 'submitting'}>
          {state === 'submitting' ? t('submitting') : t('submit')}
        </button>
      </form>
      {state === 'error' && (
        <div className="lp-form__msg lp-form__msg--error" role="alert">
          <p className="mb">{t('errorGeneric')}</p>
        </div>
      )}
      <p className="lp-cta__note lp-micro">{t('note')}</p>
    </>
  );
}
