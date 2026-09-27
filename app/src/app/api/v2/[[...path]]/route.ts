// /api/v2 — the single Next.js adapter over the platform router (phase 0).
//
// Thin on purpose (to-be doc 02: "app/ = UI + thin route adapters only"):
// translate Request → dispatch() → Response and NOTHING else. Authentication
// is decided here (Clerk session → ViewerContext or a clean problem+json 401);
// authorization is the modules' job, per operation, behind the router.
//
// v1 routes (app/src/app/api/…) are untouched and keep serving until cutover
// (AGENT-INDEX §7: do not modify v1 except to keep it running).
import { NextRequest, NextResponse, after } from 'next/server';

import { problemResponse } from '@platform/errors.mjs';

import { getRouter } from '@/server/v2/registry';
import { viewerFromClerk } from '@/server/v2/viewer';
import { dispatchOutbox } from '@/server/v2/dispatcher';

export const dynamic = 'force-dynamic';

async function handle(req: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;

  // Anonymous callers (`security: []` in the contract): the Clerk webhook
  // (svix signature over the raw body) and the RFP personal link, whose token
  // in the path IS the credential (gap S1) — the tendering handler hashes it,
  // checks expiry/revocation, and never leaks whether it exists. Neither
  // authenticates with a session, so both bypass the viewer resolution below.
  const machineCaller = path[0] === 'webhooks' || path[0] === 'rfp-links';

  const viewer = machineCaller ? null : await viewerFromClerk();
  if (!viewer && !machineCaller) {
    return respond(problemResponse('unauthenticated', 'sign in to use /api/v2'));
  }

  let body: unknown = null;
  let rawBody: string | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    rawBody = await req.text();
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        if (!machineCaller) {
          return respond(problemResponse('validation_failed', 'request body is not valid JSON'));
        }
      }
    }
  }

  const result = await getRouter().dispatch({
    method: req.method,
    path: `/${path.join('/')}`,
    viewer,
    query: Object.fromEntries(req.nextUrl.searchParams),
    body,
    rawBody,
    headers: Object.fromEntries(req.headers),
  });

  // A successful write may have published outbox events in its transaction —
  // drain them once the response is out. after() keeps the request fast and
  // the consumers close behind the commit; the cron tick catches anything a
  // dying instance drops here.
  if (req.method !== 'GET' && req.method !== 'HEAD' && result.status < 400) {
    after(() => dispatchOutbox());
  }
  return respond(result);
}

function respond(res: { status: number; body: unknown; headers: Record<string, string> }) {
  return NextResponse.json(res.body, { status: res.status, headers: res.headers });
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
