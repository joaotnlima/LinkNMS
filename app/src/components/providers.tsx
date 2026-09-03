// The Clerk provider for the whole portal (LINA-129 §6; LINA-124 auth cutover).
//
// This moved from `@clerk/clerk-react` to `@clerk/nextjs` in 0B. The react
// package can only authenticate the BROWSER: it has no server story, so every
// server component and route handler was still reading the old `lnms_session`
// HMAC cookie. Two authorities for "who is acting" is exactly the drift the
// gateway's own comments warn about, so there is now one — Clerk — and
// `@clerk/nextjs` is the only Clerk package that spans both halves
// (`clerkMiddleware` + `auth()` server-side, the same hooks client-side).
//
// Note it is NOT marked 'use client': ClerkProvider from @clerk/nextjs is a
// server component that renders its own client boundary, which is what lets the
// server read the session before the browser has hydrated.
import { ClerkProvider } from '@clerk/nextjs';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export function Providers({ children }: { children: React.ReactNode }) {
  if (!PUBLISHABLE_KEY) {
    // Build-time / preview without keys: render without Clerk. Auth then fails
    // closed — `currentSession()` returns null and every members-only surface
    // redirects to /sign-in, which renders the "not configured" notice. That is
    // the correct signal, and it keeps `next build` working in keyless CI.
    return <>{children}</>;
  }

  return <ClerkProvider publishableKey={PUBLISHABLE_KEY}>{children}</ClerkProvider>;
}
