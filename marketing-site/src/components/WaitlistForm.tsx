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
export function WaitlistForm({ source }: { source: string }) {
  const t = useTranslations('waitlist');
  const locale = useLocale();
  const [state, setState] = useState<State>('idle');
  const roleOptions = t.raw('roleOptions') as string[];

  // Site key is public and inlined at build time. When unset (local dev) the
  // widget is skipped and the server, lacking a secret, skips verification too.
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // form_start fires once per mount, on the first focus of the email field.
  const startedRef = useRef(false);

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
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          role: String(data.get('role') || ''),
          company: String(data.get('company') || ''), // honeypot
          turnstileToken: String(data.get('cf-turnstile-response') || ''),
          locale,
          source
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
      <div className="form-msg" role="status">
        <p className="mt">{t('successTitle')}</p>
        <p className="mb">{state === 'dup' ? t('errorDup') : t('successBody')}</p>
      </div>
    );
  }

  return (
    <>
      <form className="field" onSubmit={onSubmit} noValidate>
        <div className="inp">
          <label htmlFor="email">{t('email')}</label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder={t('emailPh')}
            required
            autoComplete="email"
            onFocus={onEmailFocus}
          />
        </div>
        <div className="inp">
          <label htmlFor="role">{t('role')}</label>
          <select id="role" name="role">
            {roleOptions.map((r, i) => (
              <option key={i} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        {/* Honeypot — real users never fill this */}
        <div className="hp" aria-hidden="true">
          <label htmlFor="company">Company</label>
          <input id="company" name="company" type="text" tabIndex={-1} autoComplete="off" />
        </div>
        {siteKey && <div ref={widgetRef} className="cf-turnstile-widget" />}
        <button className="btn-pill" type="submit" disabled={state === 'submitting'}>
          {state === 'submitting' ? t('submitting') : t('submit')}
        </button>
      </form>
      {state === 'error' && (
        <div className="form-msg error" role="alert">
          <p className="mb">{t('errorGeneric')}</p>
        </div>
      )}
      <p className="note">{t('note')}</p>
    </>
  );
}
