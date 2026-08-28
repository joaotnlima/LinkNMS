import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Security guard (LINA-63): `NEXT_PUBLIC_*` env vars are inlined as literal
// strings into the client bundle at build time, so anything here is served to
// every visitor. Only a PostHog *ingestion* key (`phc_` prefix — public-safe,
// write-only) is allowed to ship. A personal API key (`phx_` prefix) is
// account-scoped read/write and must never reach the browser; fail the build
// loudly rather than bake such a credential into static JS again.
const publicPosthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
if (publicPosthogKey && publicPosthogKey.startsWith('phx_')) {
  throw new Error(
    'NEXT_PUBLIC_POSTHOG_KEY is a PostHog personal API key (phx_ prefix), which is ' +
      'account-scoped and would be exposed in the client bundle. Use a project ' +
      'ingestion key (phc_ prefix) instead. Build aborted — see LINA-63.'
  );
}

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false
};

export default withNextIntl(nextConfig);
