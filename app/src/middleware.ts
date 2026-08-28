// Send anonymous visitors to sign-in before a surface tries to read (LINA-57).
//
// This is a ROUTING convenience, not a security control, and the distinction is
// deliberate: it checks only that a session cookie is PRESENT, never that it is
// valid. Real verification is the HMAC check in services/identity/session.mjs,
// which runs server-side on every single request through @/lib/api — a forged or
// expired cookie sails past this file and is then rejected there.
//
// Why presence-only: verifying here would mean running the signing secret in
// middleware (edge runtime) and would create a SECOND place that decides who is
// authenticated. Two authenticators drift, and the one that drifts quietly is
// the one that is only a redirect. One authority, plus a redirect that guesses.
import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'lnms_session';

export function middleware(req: NextRequest) {
  if (req.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/sign-in';
  url.search = '';
  // Preserve where they were going, path-only (never the full URL — that is how
  // a sign-in page becomes an open redirect).
  url.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // The record surfaces only. /sign-in, /api/* and static assets are excluded —
  // /api in particular must return a clean 401 to its caller, never an HTML
  // redirect, or every client sees a parse error instead of an auth error.
  matcher: ['/projects/:path*', '/change-orders/:path*', '/invitations/:path*'],
};
