// Analytics wiring from environment (LINA-55).
//
// The API layer / service composition root calls `analyticsFromEnv()` once and
// passes the returned analytics into every service. With no PostHog key present
// (CI, local, tests) it returns a noop-backed analytics, so the exact same
// instrumentation code runs everywhere and a missing key is a silent drop, never
// a crash.
//
// Env:
//   POSTHOG_API_KEY   PostHog *project* API key (write key; safe to ship server-side)
//   POSTHOG_HOST      ingestion host (default https://us.i.posthog.com)
//   RELEASE_SHA       build sha stamped on every event (§2.4); falls back to
//                     VERCEL_GIT_COMMIT_SHA when present.

import { createAnalytics } from './analytics.mjs';
import { createPosthogSink, createNoopSink } from './sink.mjs';

export function analyticsFromEnv(env = process.env) {
  const releaseSha = env.RELEASE_SHA || env.VERCEL_GIT_COMMIT_SHA || null;
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) {
    return createAnalytics({ sink: createNoopSink(), releaseSha });
  }
  const sink = createPosthogSink({
    apiKey,
    host: env.POSTHOG_HOST || 'https://us.i.posthog.com',
    onError: (err) => console.warn('[analytics] posthog sink error:', err?.message),
  });
  return createAnalytics({
    sink,
    releaseSha,
    onError: (err, ctx) => console.warn('[analytics] emit dropped:', ctx?.event, err?.message),
  });
}
