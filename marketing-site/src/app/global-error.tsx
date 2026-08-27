'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';
import { initPostHog, isAnalyticsEnabled } from '@/lib/analytics-client';

export default function GlobalError({
  error,
  reset
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  useEffect(() => {
    // This boundary replaces the root layout, so PostHogProvider is unmounted —
    // initialize on demand (no-op without the key) before capturing.
    if (!isAnalyticsEnabled()) return;
    initPostHog();
    posthog.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main>
          <h1>Something went wrong</h1>
          <p>Please try again.</p>
          <button type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
