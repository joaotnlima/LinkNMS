// Clerk middleware: establish the request's auth state, and send anonymous
// visitors to sign-in before a record surface tries to read (LINA-124, 0B).
//
// Two jobs, and only the first is load-bearing:
//
//  1. `clerkMiddleware()` attaches the verified Clerk auth state to the request.
//     `auth()` in a server component or route handler reads THAT — so this must
//     run on every path those live on, which is why the matcher below is broad
//     (everything but static assets) even though only three route groups are
//     actually gated.
//
//  2. The redirect for the record surfaces. As before, this is a ROUTING
//     convenience, not a security control: real verification is server-side, in
//     `@/server/session` → `auth()`, on every request through `@/lib/api`. One
//     authority, plus a redirect that guesses — unchanged from the cookie era,
//     except the authority is now Clerk instead of an HMAC we minted ourselves.
//
// `/api/*` is matched (Clerk state must exist there too) but never redirected —
// an API route must return a clean 401 to its caller, never an HTML redirect, or
// every client sees a parse error instead of an auth error.
import { NextResponse, type NextRequest } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtectedRoute = createRouteMatcher([
  '/projects(.*)',
  '/change-orders(.*)',
  '/invitations(.*)',
]);

// A keyless preview/CI build must still serve pages. `clerkMiddleware()` throws
// without a publishable key, so in that environment the middleware is a
// pass-through and `currentSession()` reports nobody signed in — the surfaces
// then redirect to /sign-in, which renders the "not configured" notice.
const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

const passthrough = () => NextResponse.next();

export default clerkConfigured
  ? clerkMiddleware(async (auth, req) => {
      if (!isProtectedRoute(req)) return;

      const { userId } = await auth();
      if (userId) return;

      const url = req.nextUrl.clone();
      url.pathname = '/sign-in';
      url.search = '';
      // Preserve where they were going, path-only (never the full URL — that is
      // how a sign-in page becomes an open redirect).
      url.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
      return NextResponse.redirect(url);
    })
  : (_req: NextRequest) => passthrough();

export const config = {
  matcher: [
    // Everything except Next internals and static files — Clerk's recommended
    // matcher. Narrowing it to just the gated routes would break `auth()` on
    // every OTHER route, which is the failure mode that reads as "signed in
    // users are anonymous on the home page".
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
