'use client';

import posthog from 'posthog-js';

// Client-side PostHog for the marketing-site waitlist funnel (LINA-46 / spec
// LINA-33 §3). Everything here is a NO-OP unless NEXT_PUBLIC_POSTHOG_KEY is set,
// so local dev and preview deploys without the key stay silent and side-effect
// free. Host defaults to the EU cloud ingest endpoint.
//
// Funnel event names — reconciled with the LINA-33 tracking spec (canonical) and
// the LINA-46 scope wording:
//   LINA-33 (canonical)   LINA-46 wording         fired by
//   page_view             pageview                PostHogProvider (route change)
//   hero_view             hero_view               Hero (enters viewport, once)
//   scroll_depth          —                       PostHogProvider (25/50/75/100%)
//   cta_click             cta_click/placement     CtaLink (header|hero|final)
//   audience_card_click   audience_card_select    Audience (persona)
//   form_start            —                       WaitlistForm (first email focus)
//   (waitlist_submitted)  email_submit            SERVER /api/waitlist — NOT re-fired
//   (waitlist_verified)   email_confirmed         SERVER /api/confirm  — NOT re-fired
//   language_switch       language_switch         LangSwitcher (from/to)
//
// The two conversion events are captured server-side against the normalized email
// as distinct_id. To join the anonymous browsing session to them we call
// identifyByEmail() on a successful submit — see WaitlistForm.
//
// Global super-properties `locale` and `source` are attached to every event by
// PostHogProvider (see LINA-33: "every event carries locale and source").

const DEFAULT_HOST = 'https://eu.i.posthog.com';

let initialized = false;

export function isAnalyticsEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);
}

export function initPostHog(): void {
  if (initialized || typeof window === 'undefined') return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_HOST,
    // We fire page_view manually so it carries locale/source/path.
    capture_pageview: false,
    capture_pageleave: true,
    // Keep the funnel clean and intentional; no DOM autocapture noise.
    autocapture: false,
    respect_dnt: true,
    // This site uses no feature flags, surveys, or session replay, so skip the
    // remote-config / flags roundtrip entirely — fewer requests per load, less
    // egress, and capture is no longer gated on that response. (Both the legacy
    // and current option names, so it holds across posthog-js versions.)
    advanced_disable_decide: true,
    advanced_disable_flags: true,
    // Opt-in verbose logging for local QA (never set in prod).
    loaded: (ph) => {
      if (process.env.NEXT_PUBLIC_POSTHOG_DEBUG === '1') ph.debug();
    }
  });
  initialized = true;
}

// Fire a funnel event. Silently no-op when analytics is disabled.
export function track(event: string, properties?: Record<string, unknown>): void {
  if (!isAnalyticsEnabled()) return;
  posthog.capture(event, properties);
}

// Register super-properties merged into every subsequent capture().
export function registerGlobals(properties: Record<string, unknown>): void {
  if (!isAnalyticsEnabled()) return;
  posthog.register(properties);
}

// Join this browser's anonymous session to the server-side conversion events,
// which are keyed on the normalized email. Idempotent within a session.
export function identifyByEmail(normalizedEmail: string): void {
  if (!isAnalyticsEnabled() || !normalizedEmail) return;
  posthog.identify(normalizedEmail);
}

// Resolve the acquisition `source` once per session (UTM > referrer host >
// "direct"), persisted so it survives from landing through to the submit — the
// single most common tracking bug called out in the LINA-33 spec.
const SOURCE_KEY = 'lnms_source';

export function resolveSource(): string {
  if (typeof window === 'undefined') return 'direct';
  try {
    const stored = window.sessionStorage.getItem(SOURCE_KEY);
    if (stored) return stored;
  } catch {
    /* storage blocked — fall through and recompute */
  }

  const params = new URLSearchParams(window.location.search);
  const utm =
    params.get('utm_source') ||
    params.get('utm_medium') ||
    params.get('utm_campaign');

  let source = 'direct';
  if (utm) {
    source = utm;
  } else if (document.referrer) {
    try {
      const host = new URL(document.referrer).hostname;
      if (host && host !== window.location.hostname) source = host;
    } catch {
      /* malformed referrer — keep "direct" */
    }
  }

  source = source.slice(0, 120);
  try {
    window.sessionStorage.setItem(SOURCE_KEY, source);
  } catch {
    /* ignore */
  }
  return source;
}
