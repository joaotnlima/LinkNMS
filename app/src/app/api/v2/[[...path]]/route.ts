// /api/v2 — the single Next.js adapter over the platform router (phase 0).
//
// Thin on purpose (to-be doc 02: "app/ = UI + thin route adapters only"):
// translate Request → dispatch() → Response and NOTHING else. Authentication
// is decided here (Clerk session → ViewerContext or a clean problem+json 401);
// authorization is the modules' job, per operation, behind the router.
//
// v1 routes (app/src/app/api/…) are untouched and keep serving until cutover
// (AGENT-INDEX §7: do not modify v1 except to keep it running).
import { NextRequest, NextResponse } from 'next/server';

import { problemResponse } from '@platform/errors.mjs';

import { getRouter } from '@/server/v2/registry';
import { viewerFromClerk } from '@/server/v2/viewer';

export const dynamic = 'force-dynamic';

async function handle(req: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;

  // Machine callers (`security: []` in the contract — today only the Clerk
  // webhook) authenticate inside their handler (svix signature over the raw
  // body), never with a session.
  const machineCaller = path[0] === 'webhooks';

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
  return respond(result);
}

function respond(res: { status: number; body: unknown; headers: Record<string, string> }) {
  return NextResponse.json(res.body, { status: res.status, headers: res.headers });
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
