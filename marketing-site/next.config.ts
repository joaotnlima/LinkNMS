import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// PostHog key (LINA-63). Vercel refuses to store a `NEXT_PUBLIC_*` var as a
// "sensitive" secret — by definition those are public — so the value is
// configured under the neutral name `POSTHOG_KEY` and mapped to the client var
// here. `NEXT_PUBLIC_POSTHOG_KEY` stays supported as a fallback for existing
// local `.env` files.
const posthogKey =
  process.env.POSTHOG_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY || '';

// Security guard (LINA-63): whatever lands in `NEXT_PUBLIC_*` is inlined as a
// literal string into the client bundle at build time, so it is served to every
// visitor. Only a PostHog *ingestion* key (`phc_` prefix — public-safe,
// write-only) may ship. A personal API key (`phx_` prefix) is account-scoped
// read/write and must never reach the browser; fail the build loudly rather
// than bake such a credential into static JS again.
if (posthogKey.startsWith('phx_')) {
  throw new Error(
    'The configured PostHog key (POSTHOG_KEY / NEXT_PUBLIC_POSTHOG_KEY) is a ' +
      'personal API key (phx_ prefix), which is account-scoped and would be ' +
      'exposed in the client bundle. Use a project ingestion key (phc_ prefix) ' +
      'instead. Build aborted — see LINA-63.'
  );
}

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_POSTHOG_KEY: posthogKey
  }
};

export default withNextIntl(nextConfig);
