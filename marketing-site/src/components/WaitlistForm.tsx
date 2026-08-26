'use client';

import { useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';

type State = 'idle' | 'submitting' | 'success' | 'dup' | 'error';

// Waitlist capture with double opt-in: POST /api/waitlist inserts 'unconfirmed'
// and sends a tokenized confirmation email. Honeypot + optional Turnstile token
// are posted for the server-side spam checks.
export function WaitlistForm({ source }: { source: string }) {
  const t = useTranslations('waitlist');
  const locale = useLocale();
  const [state, setState] = useState<State>('idle');
  const roleOptions = t.raw('roleOptions') as string[];

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setState('submitting');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: String(data.get('email') || ''),
          role: String(data.get('role') || ''),
          company: String(data.get('company') || ''), // honeypot
          turnstileToken: String(data.get('cf-turnstile-response') || ''),
          locale,
          source
        })
      });
      if (res.status === 409) {
        setState('dup');
      } else if (res.ok) {
        setState('success');
        form.reset();
      } else {
        setState('error');
      }
    } catch {
      setState('error');
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
          <input id="email" name="email" type="email" placeholder={t('emailPh')} required autoComplete="email" />
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
