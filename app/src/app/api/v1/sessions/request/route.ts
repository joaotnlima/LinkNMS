// POST /api/v1/sessions/request — the "proof" half of sign-in, step 1
// (LINA-76, ADR-0007). Body `{ email, displayName? }` → mint a single-use magic
// link and email it. ALWAYS 202 {} whether or not the email is a known party, so
// this endpoint is not a "who is on this build?" oracle (ADR-0007 §4).
//
// The ONLY non-202 is a 503 when email delivery is unconfigured: sign-in FAILS
// CLOSED (ADR-0007 §5) — it never logs or returns the link. That 503 is uniform
// for every caller and leaks nothing about the address.
//
// The acting party is irrelevant here (nobody is signed in yet); this route does
// not go through the session gateway. Rate limiting lives in the service, counted
// in Postgres (a serverless deploy has no shared memory).
import { NextResponse } from 'next/server';
import { container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

// The public origin to build the magic link against. Behind Vercel's proxy the
// forwarded headers carry the real host/proto; APP_BASE_URL is an explicit
// override for environments where they are not trustworthy.
function originOf(req: Request): string {
  const env = process.env.APP_BASE_URL;
  if (env) return env.replace(/\/+$/, '');
  const h = req.headers;
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

// Best-effort client IP for the per-IP rate limit. The left-most x-forwarded-for
// hop is the closest we get on Vercel; absent → null (the limit still holds
// per-email).
function ipOf(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim() || null;
  return req.headers.get('x-real-ip');
}

export async function POST(req: Request) {
  let body: { email?: string; displayName?: string; next?: string } = {};
  try {
    body = await req.json();
  } catch {
    // A malformed body is treated as a malformed email: still 202, nothing sent.
    body = {};
  }

  try {
    await container().signIn.request({
      email: body?.email,
      displayName: body?.displayName,
      next: body?.next,
      ip: ipOf(req),
      baseUrl: originOf(req),
    });
    // 202 Accepted, empty body — the same answer for known, unknown, malformed,
    // and rate-limited addresses (ADR-0007 §4).
    const res = new NextResponse(null, { status: 202 });
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    // 503 email_unconfigured (fail closed) and 502 email_send_failed are the only
    // expected throws; both are server-side and uniform across addresses.
    if (typeof e.status === 'number' && typeof e.code === 'string') {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    }
    console.error('[api] sign-in request failed', err);
    return NextResponse.json({ error: { code: 'internal', message: 'internal error' } }, { status: 500 });
  }
}
