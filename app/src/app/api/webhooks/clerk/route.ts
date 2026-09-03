// POST /api/webhooks/clerk — Clerk identity sync webhook (LINA-143; Auth Bridge §5 A).
//
// Clerk delivers lifecycle events (user.created, organizationMembership.created,
// …) signed by Svix. Authenticity is verified with the endpoint secret before
// ANY state is touched — a forged POST is a forged identity write, so a bad
// signature is a hard 401 with no side effects.
//
// The body must be read as raw bytes/text: the Svix signature is over the EXACT
// delivered content, so `req.json()` (a re-serialisation) would break the MAC.
// We read the raw text, verify, then hand the handler the raw string and the
// headers; it parses + applies the event idempotently against the `authz` schema.
//
// This endpoint is a *different* trust model from the user-session gateway
// (ADR-0004): its caller is Clerk-the-platform, not an end-user Party, so it uses
// the Svix signature rather than a browser session cookie and does not touch the
// session cookie jar.
import { NextResponse } from 'next/server';
import { createPgAuthStore } from '@services/auth/pg-store.mjs';
import { createAuthSyncService } from '@services/auth/sync.mjs';
import { createClerkWebhookHttp } from '@services/auth/webhook.mjs';

export const dynamic = 'force-dynamic';

// Composition root for the webhook path. Built once per process on first request
// (the DB pool is process-global via ledger/db). Framework-agnostic service
// handlers at the core; this file is the only Next-specific part.
let handler: Awaited<ReturnType<typeof createClerkWebhookHttp>> | null = null;
function webhook() {
  if (!handler) {
    const store = createPgAuthStore();
    const sync = createAuthSyncService({ store });
    handler = createClerkWebhookHttp({ sync });
  }
  return handler;
}

export async function POST(req: Request) {
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headers[k.toLowerCase()] = v;

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'could not read request body' } },
      { status: 400 },
    );
  }

  const result = await webhook().handle({ rawBody, headers });
  if ('body' in result && result.body !== null && result.body !== undefined) {
    return NextResponse.json(result.body, { status: result.status });
  }
  return new NextResponse(null, { status: result.status });
}
