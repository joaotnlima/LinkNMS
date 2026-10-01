// Data-access layer for the R0 surfaces — the real API, no fixtures (LINA-57).
//
// ── WHAT CHANGED AND WHY ─────────────────────────────────────────────────────
// This module used to fall back to the "Maple Street" demo fixtures whenever
// LINKNMS_API_BASE was unset, which was the honest choice while no domain routes
// existed. They exist now (LINA-56), and the fallback is DELETED rather than
// merely defaulted-off. On a product whose single promise is "what was agreed,
// what changed, what it cost", a misconfiguration that renders invented numbers
// under a real project's name is strictly worse than an error page: the error is
// survivable, the invented number gets quoted in an argument. Everything here
// fails loudly instead.
//
// ── THE TWO TRANSPORTS ───────────────────────────────────────────────────────
// `LINKNMS_API_BASE` unset (the default, and how the app deploys today): call
// the service handlers IN PROCESS. The Next pages are server components running
// in the same process as the composition root, so an HTTP hop to ourselves would
// buy nothing and cost a cold connection, a self-referential base URL to get
// wrong in serverless, and a second place cookies must be forwarded correctly.
//
// `LINKNMS_API_BASE` set: go over HTTP to that origin, forwarding the caller's
// session cookie. This is what lets an E2E run drive a deployed preview, and it
// is the reason the ROUTES table below exists: both transports are derived from
// ONE declaration of every operation, so the in-process path cannot quietly
// diverge from the URL the outside world calls.
//
// Either way the request is authorised identically — authorization lives in the
// service handlers (ADR-0004), not in the Next route files — so the in-process
// path is not a privilege shortcut. The acting party comes from the verified
// Clerk session and nothing else (LINA-124).
import { cookies, headers as requestHeaders } from 'next/headers';

import { getContainer } from '@services/gateway/container.mjs';
import { normaliseParams } from '@services/gateway/params.mjs';
import { getAnalytics } from '@services/composition.mjs';

import { currentSession, isSignedIn } from '@/server/session';

// Re-exported: the surfaces already import their auth probe from here, and the
// resolution itself now lives beside the rest of the session logic.
export { isSignedIn };

// Carved to the invitation path (LINA-387 Phase 12c, Option B): every other v1
// reader/writer function was removed here, so only the invitation-preview type
// and the shared transport machinery below survive. The retained identity +
// gateway + session slice backs both the live Clerk→party auth and invitations.
import type { InvitationPreview } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when there is no signed-in party. Surfaces route to sign-in. */
export class UnauthenticatedError extends ApiError {
  constructor() {
    super(401, 'Sign in to view this record', 'unauthenticated');
    this.name = 'UnauthenticatedError';
  }
}

/**
 * The plan allowance, exactly as the service stated it (LINA-205, ADR-0013).
 *
 * These three numbers are on the wire SPECIFICALLY so this app does not keep a
 * second copy of the pricing table. `limit` is what the seat's plan runs;
 * `owned` is what the party already owns. Neither is ever re-derived here — the
 * allowance lives in services/identity/plans.mjs and re-pricing must not require
 * a front-end deploy to stay truthful.
 */
export interface PlanLimit {
  /** The plan key on the seat, or null for a seat that carries none. */
  plan: string | null;
  /** How many builds that plan runs at once. Never null here: an unlimited tier never refuses. */
  limit: number;
  /** How many the party already owns. Equal to `limit` at the moment of refusal. */
  owned: number;
}

/**
 * `409 plan_limit_reached`. A subclass rather than a flag on ApiError so a
 * surface that wants the plan-aware screen asks for it by type, and every other
 * catch site keeps treating it as the ApiError it already handles.
 *
 * 409 and not 402/403 is deliberate and reasoned in ADR-0013: 403 says "you may
 * never do this", and the honest statement is "you already run as many builds as
 * your plan allows" — a collision with reality the owner resolves. The
 * specificity lives in `code`, which is stable.
 */
export class PlanLimitError extends ApiError {
  constructor(status: number, message: string, public entitlement: PlanLimit) {
    super(status, message, 'plan_limit_reached');
    this.name = 'PlanLimitError';
  }
}

const API_BASE = process.env.LINKNMS_API_BASE;

/** True when reads go over HTTP to `LINKNMS_API_BASE` instead of in-process. */
export function isRemote(): boolean {
  return typeof API_BASE === 'string' && API_BASE.length > 0;
}

// ── The one operation table ──────────────────────────────────────────────────
// `path` must stay byte-identical to the app/src/app/api/v1 route segments; the
// HTTP transport is the only consumer, but keeping it beside the handler is what
// makes a mismatch reviewable in one place.

type Params = Record<string, string>;
type Handler = (ctx: { session: { partyId: string } | null; params: Params; body: unknown; headers: Record<string, string> }) => Promise<{ status: number; body?: unknown }>;

interface Op {
  method: 'GET' | 'POST' | 'PATCH';
  path: (p: Params) => string;
  handler: (c: ReturnType<typeof getContainer>) => Handler;
}

const ROUTES = {
  acceptInvitation: {
    method: 'POST', path: (p) => `/invitations/${enc(p.token)}/accept`,
    handler: (c) => c.http.identity.acceptInvitation,
  },
  previewInvitation: {
    method: 'GET', path: (p) => `/invitations/${enc(p.token)}`,
    handler: (c) => c.http.identity.previewInvitation,
  },
} satisfies Record<string, Op>;

type OpName = keyof typeof ROUTES;

// A project id or token is user-controlled and lands in a URL path. Encoding is
// the HTTP transport's business only, but doing it in the shared table means it
// cannot be forgotten on the one route someone adds later.
const enc = (v: string | undefined) => encodeURIComponent(v ?? '');

// The services already return a typed `{ error: { code, message } }` body for
// every domain failure, so there is exactly one error-shaping story regardless
// of transport.
function raise(status: number, body: unknown): never {
  const e = (body as {
    error?: { code?: string; message?: string; plan?: unknown; limit?: unknown; owned?: unknown };
  })?.error;
  if (status === 401) throw new UnauthenticatedError();
  const msg = e?.message ?? `request failed (${status})`;

  // The one error body that carries more than {code, message} on a path a screen
  // reacts to. Both transports reach it: the HTTP one parses the same envelope
  // the in-process handler returns, because errorBody() in identity/http.mjs is
  // the single place either shape is built.
  //
  // Guarded on the NUMBERS, not on the code alone. `plan_limit_reached` without
  // usable numbers would render "0 of 0 builds in use", which is worse than the
  // service's own sentence — so an envelope missing them degrades to a plain
  // ApiError and the caller shows the message it already showed.
  if (e?.code === 'plan_limit_reached'
      && typeof e.limit === 'number' && typeof e.owned === 'number') {
    throw new PlanLimitError(status, msg, {
      plan: typeof e.plan === 'string' ? e.plan : null,
      limit: e.limit,
      owned: e.owned,
    });
  }
  throw new ApiError(status, msg, e?.code ?? 'error');
}

async function call<T>(op: OpName, params: Params = {}, body?: unknown): Promise<T> {
  const route: Op = ROUTES[op];
  const s = await currentSession();
  // Fail before the round trip: every one of these endpoints is members-only, so
  // an anonymous caller is a redirect to sign-in, not a 403 rendered as a crash.
  if (!s) throw new UnauthenticatedError();

  // Alias `[id]` ⇄ `projectId` and reject a malformed identifier BEFORE either
  // transport — so a stale bookmark to /projects/not-a-uuid is a 400 here rather
  // than a `uuid` cast error deep in Postgres, and so both transports answer it
  // identically instead of only the remote one being checked.
  const p = withAliases(params);

  let result: { status: number; body?: unknown };
  if (isRemote()) {
    // The remote gateway runs handle(), which flushes on its own side.
    result = await callHttp(route, p, body);
  } else {
    // THE FLUSH (LINA-58), repeated here on purpose. gateway.ts's `handle()`
    // says "every API route funnels through this one function" — true of the
    // /api/v1 route files, and no longer true of the UI, which since this
    // cutover reaches the same handlers IN PROCESS without passing through it.
    // The PostHog sink buffers captures, and Vercel can freeze the instance the
    // moment the response is written, so skipping this drops the analytics for
    // exactly the path real users take (the 8-event spine, LINA-55/28).
    //
    // `finally`, matching handle(): a failed write has usually emitted the more
    // interesting events, and losing precisely the failure telemetry would be
    // the worst possible sampling bias. Analytics is best-effort by contract —
    // a flush problem must never become a render failure on the record itself.
    try {
      // Real request headers, not `{}` (LINA-84). The invite handler builds the
      // emailed accept link from the forwarded host/proto, so an empty bag here
      // would mail every GC a `localhost:3000` link on the exact path real users
      // take. gateway.ts already forwards them for the /api/v1 routes; the
      // in-process transport bypasses that file, so it must do the same.
      //
      // `p`, not a second withAliases(params): LINA-79 hoisted the aliasing and
      // the malformed-identifier check above the transport split so both paths
      // answer a bad id identically. Re-deriving it here would validate twice
      // and leave a second call site to drift.
      result = await route.handler(getContainer())({
        session: s,
        params: p,
        body,
        headers: Object.fromEntries((await requestHeaders()).entries()),
      });
    } finally {
      try {
        await getAnalytics().flush();
      } catch (flushErr) {
        console.warn('[ui] analytics flush failed', flushErr);
      }
    }
  }

  if (result.status >= 400) raise(result.status, result.body);
  return result.body as T;
}

// `call()` for the ONE public operation (LINA-182). Every other op in ROUTES is
// members-only, and `call()` fails an anonymous caller with
// UnauthenticatedError BEFORE the round trip — correct for the portal, fatal
// for the invite preview, which exists precisely to serve a signed-out visitor
// holding only the token. This variant keeps everything else identical (same
// aliasing, same transport split, same rate-limited handler) but lets the
// session be null.
async function callPublic<T>(op: OpName, params: Params = {}): Promise<T> {
  const route: Op = ROUTES[op];
  const s = await currentSession(); // null for the deep-link visitor; the handler accepts it
  const p = withAliases(params);

  let result: { status: number; body?: unknown };
  if (isRemote()) {
    result = await callHttp(route, p, undefined);
  } else {
    try {
      result = await route.handler(getContainer())({
        session: s,
        params: p,
        body: undefined,
        headers: Object.fromEntries((await requestHeaders()).entries()),
      });
    } finally {
      try {
        await getAnalytics().flush();
      } catch (flushErr) {
        console.warn('[ui] analytics flush failed', flushErr);
      }
    }
  }

  if (result.status >= 400) raise(result.status, result.body);
  return result.body as T;
}

// The service handlers name the project param `projectId`; the Next segment is
// `[id]`. app/src/server/gateway.ts normalises both directions for the HTTP
// routes — the in-process transport bypasses that file, so it must do the same
// thing here or a handler reads `undefined` and returns a perfectly plausible
// 403 on the owner's own project.
//
// It used to do that with a second copy of the aliasing; both transports now call
// the ONE implementation in services/gateway/params.mjs, which additionally
// rejects a malformed identifier as a typed 400 before it can become a Postgres
// `uuid` parameter (LINA-79). Translated to ApiError here so the surfaces see the
// same error type they already handle.
function withAliases(params: Params): Params {
  try {
    return normaliseParams(params) as Params;
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    if (typeof e?.status === 'number' && typeof e?.code === 'string') {
      throw new ApiError(e.status, e.message ?? 'bad request', e.code);
    }
    throw err;
  }
}

async function callHttp(route: Op, params: Params, body: unknown): Promise<{ status: number; body?: unknown }> {
  const jar = await cookies();
  const res = await fetch(`${API_BASE}/api/v1${route.path(params)}`, {
    method: route.method,
    headers: {
      accept: 'application/json',
      // Forward the cookie jar verbatim — since LINA-124 that carries Clerk's
      // session cookie. The remote gateway re-verifies it with Clerk, so this
      // transport grants nothing the caller did not already have.
      cookie: jar.toString(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  return { status: res.status, body: text ? safeJson(text) : undefined };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { error: { code: 'bad_gateway', message: 'malformed response from API' } }; }
}

// ── Invitation path (RETAINED under Option B until v2 invitations land, LINA-398)

export async function acceptInvitation(token: string): Promise<{ projectId: string }> {
  const res = await call<{ membership: { projectId: string } }>('acceptInvitation', { token });
  return { projectId: res.membership.projectId };
}

/**
 * The Band B accept deep link's UNAUTHENTICATED read (M6/D6, LINA-182). Only
 * reachable by a visitor who holds a live token — which is exactly who the
 * landing page shows "which build, invited by whom, at which email". Unknown
 * and already-used tokens both 404 identically, and the endpoint is
 * rate-limited; it must never be treated as a token-validity oracle.
 */
export async function getInvitationPreview(token: string): Promise<InvitationPreview> {
  return callPublic<InvitationPreview>('previewInvitation', { token });
}
