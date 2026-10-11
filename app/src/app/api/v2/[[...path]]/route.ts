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
  // (svix signature over the raw body); the RFP personal link, whose token in
  // the path IS the credential (gap S1); and the invitation-accept deep-link
  // PREVIEW (LINA-398) — a GET on `/project-invitations/{token}`, whose token is
  // likewise the credential and whose handler is anti-oracle; and the share
  // link holder's GETs on `/shared/{token}` (PRD-12 N-12, no account — the
  // token is the credential, refused tokens answer 404/410). The invitation
  // :accept POST is deliberately NOT anonymous: it still needs a verified
  // session (ADR-0004), so it falls through to viewer resolution and a clean 401.
  // Each handler hashes the token, checks expiry/revocation, and never leaks
  // whether it exists.
  const machineCaller =
    path[0] === 'webhooks'
    || path[0] === 'rfp-links'
    || (req.method === 'GET' && path[0] === 'project-invitations')
    || (req.method === 'GET' && path[0] === 'shared');

  // Public directory reads (PRD-03 R-9, `security: []`): the taxonomy, company
  // search and profiles answer anonymous visitors. A signed-in caller is still
  // resolved — near_project needs its relationships, and a company's own
  // views are not counted.
  const publicRead = req.method === 'GET' && (path[0] === 'specialties' || path[0] === 'directory');

  const viewer = machineCaller ? null : await viewerFromClerk();
  if (!viewer && !machineCaller && !publicRead) {
    return respond(problemResponse('unauthenticated', 'sign in to use /api/v2'));
  }

  let body: unknown = null;
  let rawBody: string | null = null;
  const contentType = req.headers.get('content-type') ?? '';
  if (req.method === 'POST' && contentType.toLowerCase().startsWith('multipart/form-data')) {
    // A file upload (PRD-09: the Excel import, `uploadScheduleImport`). Pure
    // translation, no rule: string fields stay strings, a file becomes
    // {filename, content_type, size, bytes}. The handler validates type and
    // size; this edge only refuses what it will not hold in memory.
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_MULTIPART_BYTES) {
      return respond(problemResponse('validation_failed', 'the upload is larger than the API accepts'));
    }
    try {
      body = await multipartBody(await req.formData());
    } catch {
      return respond(problemResponse('validation_failed', 'request body is not valid multipart/form-data'));
    }
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
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

// 10 MB file (the import's own limit) + form overhead.
const MAX_MULTIPART_BYTES = 11 * 1024 * 1024;

async function multipartBody(form: FormData): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      out[key] = value;
    } else {
      out[key] = {
        filename: value.name,
        content_type: value.type || 'application/octet-stream',
        size: value.size,
        bytes: Buffer.from(await value.arrayBuffer()),
      };
    }
  }
  return out;
}

function respond(res: { status: number; body: unknown; headers: Record<string, string> }) {
  // 204/205 are "null body status" codes (fetch spec): constructing a Response
  // with a body throws, which surfaced as a 500 on every successful webhook and
  // DELETE — Svix reads that 500 as a failed delivery, retries, and can disable
  // the endpoint (LINA-366). Send those (and any null-body result) with no body.
  if (res.status === 204 || res.status === 205 || res.body === null || res.body === undefined) {
    return new NextResponse(null, { status: res.status, headers: res.headers });
  }
  return NextResponse.json(res.body, { status: res.status, headers: res.headers });
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
