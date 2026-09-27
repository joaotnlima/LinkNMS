// The single seam between the UI and `/api/v2` (LINA-309, UI cutover plan doc 22 §3).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Every surface being cut over from v1 to v2 talks to the pivot API through THIS
// module and nowhere else. `app/src/lib/api.ts` is the v1 equivalent; it funnels
// 37 call sites through one `call()` so both transports (in-process / HTTP) stay
// derived from one declaration. This is that same design for v2, kept separate so
// the two never share a code path while both are live — a v1 surface and a v2
// surface can coexist screen-by-screen during the slice-by-slice cutover, and
// deleting this file's v1 twin in phase 12 touches nothing here.
//
// ── THE TWO TRANSPORTS (identical contract to lib/api.ts) ────────────────────
// `LINKNMS_API_BASE` unset (the default, how the app deploys): dispatch the v2
// router IN PROCESS. The Next server components run in the same process as the
// v2 composition root (`server/v2/registry.ts`), so an HTTP hop to ourselves
// would buy nothing and cost a cold connection and a self-referential base URL.
//
// `LINKNMS_API_BASE` set: go over HTTP to `${BASE}/api/v2`, forwarding the
// caller's Clerk session cookie. This is what lets an E2E run drive a deployed
// preview. Either way authorization is decided by the module handlers behind the
// router (to-be doc 16), never here — the in-process path is not a privilege
// shortcut, and the viewer is resolved the SAME way the /api/v2 route resolves it.
import 'server-only';

import { cookies, headers as requestHeaders } from 'next/headers';
import { after } from 'next/server';

import { getRouter } from '@/server/v2/registry';
import { viewerFromClerk } from '@/server/v2/viewer';
import { dispatchOutbox } from '@/server/v2/dispatcher';

// ── Errors ───────────────────────────────────────────────────────────────────
// The v2 surface speaks problem+json (RFC 9457, platform/errors.mjs): every
// failure body is `{ type, title, status, code, detail, errors? }`, and the code
// carries the status. Surfaces react to `code`, which is stable, so this class
// preserves it verbatim rather than collapsing to a message.

/** A problem+json failure from `/api/v2`. `code` is the stable discriminator. */
export class V2Error extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail: string | null = null,
    /** Field errors for `validation_failed`; keyed by field name. */
    public errors: Record<string, string> | null = null,
  ) {
    super(message);
    this.name = 'V2Error';
  }
}

/**
 * `unauthenticated` (401). A subclass so a surface routes it to sign-in by type,
 * exactly as `lib/api.ts` distinguishes `UnauthenticatedError`. Every v2 UI read
 * is members-only, so an anonymous caller is a redirect, not a rendered crash.
 */
export class V2Unauthenticated extends V2Error {
  constructor(detail: string | null = null) {
    super(401, 'unauthenticated', detail ?? 'Sign in to use this record', detail);
    this.name = 'V2Unauthenticated';
  }
}

const API_BASE = process.env.LINKNMS_API_BASE;

/** True when v2 reads go over HTTP to `LINKNMS_API_BASE` instead of in-process. */
export function isRemote(): boolean {
  return typeof API_BASE === 'string' && API_BASE.length > 0;
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface V2Request {
  method: Method;
  /** Router-relative path, e.g. `/me`, `/projects`, `/projects/{id}` already interpolated. */
  path: string;
  /** Query string params; appended for HTTP, passed as `query` in-process. */
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Sets the `Idempotency-Key` header the write handlers dedupe on. */
  idempotencyKey?: string;
  /**
   * Allow a null viewer (a `security: []` route such as the future public RFP
   * token form, S5). Defaults false: like the /api/v2 route, an unauthenticated
   * caller on a members-only route is a 401 BEFORE dispatch, never a leak.
   */
  allowAnonymous?: boolean;
}

// The problem body shape, exactly as platform/errors.mjs builds it.
interface ProblemBody {
  status?: number;
  code?: string;
  title?: string;
  detail?: string | null;
  errors?: Record<string, string>;
}

function raise(status: number, body: unknown): never {
  const p = (body ?? {}) as ProblemBody;
  const code = p.code ?? 'internal';
  const message = p.detail || p.title || `request failed (${status})`;
  if (status === 401 || code === 'unauthenticated') throw new V2Unauthenticated(p.detail ?? null);
  throw new V2Error(status, code, message, p.detail ?? null, p.errors ?? null);
}

function queryString(query?: V2Request['query']): string {
  if (!query) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/**
 * The one v2 call. Resolves the viewer the same way the /api/v2 route does,
 * dispatches, and — matching that route — schedules the outbox drain after a
 * successful write so the module event consumers run seconds behind the commit.
 */
export async function v2<T>(req: V2Request): Promise<T> {
  const result = isRemote() ? await callHttp(req) : await callInProcess(req);
  if (result.status >= 400) raise(result.status, result.body);
  return result.body as T;
}

async function callInProcess(req: V2Request): Promise<{ status: number; body: unknown }> {
  // The route decides auth here (server/v2/[[...path]]/route.ts): a null viewer
  // on a members-only route is a clean 401, never a dispatch with no identity.
  const viewer = await viewerFromClerk();
  if (!viewer && !req.allowAnonymous) {
    return { status: 401, body: { code: 'unauthenticated', title: 'Not signed in', status: 401 } };
  }

  const headers: Record<string, string> = Object.fromEntries((await requestHeaders()).entries());
  if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;

  const result = await getRouter().dispatch({
    method: req.method,
    path: req.path,
    viewer,
    query: normaliseQuery(req.query),
    body: req.body ?? null,
    rawBody: req.body === undefined ? null : JSON.stringify(req.body),
    headers,
  });

  // Mirror the route's after(): a successful write may have published outbox
  // events in its transaction — drain them once the response is out. The cron
  // tick (/api/internal/dispatch) is the safety net for anything dropped here.
  if (req.method !== 'GET' && result.status < 400) {
    after(() => dispatchOutbox());
  }
  return { status: result.status, body: result.body };
}

function normaliseQuery(query?: V2Request['query']): Record<string, string> {
  const out: Record<string, string> = {};
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) out[k] = String(v);
    }
  }
  return out;
}

async function callHttp(req: V2Request): Promise<{ status: number; body: unknown }> {
  const jar = await cookies();
  const hasBody = req.body !== undefined && req.method !== 'GET';
  const res = await fetch(`${API_BASE}/api/v2${req.path}${queryString(req.query)}`, {
    method: req.method,
    headers: {
      accept: 'application/json',
      // Forward the cookie jar verbatim — since LINA-124 that carries Clerk's
      // session cookie. The remote router re-verifies it, so this transport
      // grants nothing the caller did not already have.
      cookie: jar.toString(),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(req.idempotencyKey ? { 'idempotency-key': req.idempotencyKey } : {}),
    },
    body: hasBody ? JSON.stringify(req.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  return { status: res.status, body: text ? safeJson(text) : undefined };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { code: 'internal', title: 'Malformed response from API', status: 502 };
  }
}
