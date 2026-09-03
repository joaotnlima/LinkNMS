'use client';

import { ClerkProvider as ClerkReactProvider } from '@clerk/clerk-react';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export function Providers({ children }: { children: React.ReactNode }) {
  if (!PUBLISHABLE_KEY) {
    // Build-time / misconfigured: render without Clerk. Auth will fail at
    // runtime when the provider is needed, which is the correct signal.
    if (typeof window !== 'undefined') {
      console.warn(
        '[providers] NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set — Clerk auth is disabled.',
      );
    }
    return <>{children}</>;
  }

  return (
    <ClerkReactProvider publishableKey={PUBLISHABLE_KEY}>
      {children}
    </ClerkReactProvider>
  );
}
