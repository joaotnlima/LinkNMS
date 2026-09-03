// The Next.js ⇄ service adapter (LINA-56).
//
// Everything web-framework-specific about the API lives in this one file:
// resolve the acting party, parse the body, call a service handler, serialise
// the result. The route files under src/app/api/v1/ are then two lines each and hold
// NO domain logic — which is the point: the services stay independently testable
// (services/*/http.test.mjs) and nothing security-relevant is duplicated per
// route where it could drift.
//
// The acting party is read ONLY from the verified Clerk session (ADR-0004;
// LINA-124 replaced the self-minted `lnms_session` HMAC cookie with Clerk).
// There is deliberately no header or query override — not even a dev-only one —
// because such an escape hatch is exactly the thing that ships to production by
// accident.
import { NextResponse } from 'next/server';

// The .mjs service modules are plain JS with JSDoc types; `allowJs` + the
// `@services/*` path mapping (tsconfig.json) type them from source, so these
// imports are checked rather than suppressed.
import { getContainer } from '@services/gateway/container.mjs';
// `[id]` ⇄ `projectId` aliasing plus the UUID shape check, shared with the
// in-process transport in src/lib/api.ts so the two cannot diverge (LINA-79).
import { normaliseParams } from '@services/gateway/params.mjs';
import { getAnalytics } from '@services/composition.mjs';

// The ONE answer to "who is acting" (LINA-124): Clerk session → verified email
// → identity party. Re-exported so the route files keep importing it from the
// gateway they already depend on.
import { currentSession, type Session } from '@/server/session';

export { currentSession };
export type { Session };

// Every route touches Postgres and a per-request session; nothing here is
// statically renderable or cacheable.
export const dynamic = 'force-dynamic';

export interface HandlerResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (ctx: {
  session: Session | null;
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}) => Promise<HandlerResult>;

export function container() {
  return getContainer();
}

// A malformed JSON body is `undefined`, not a crash: the services already
// validate their inputs and return a typed 400, so there is one validation story
// rather than two.
async function readBody(req: Request): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  try {
    const text = await req.text();
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function toResponse(result: HandlerResult): NextResponse {
  if (result.status === 304 || result.body === null || result.body === undefined) {
    return new NextResponse(null, { status: result.status, headers: result.headers });
  }
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

/**
 * Run a service handler for a Next route. Route params arrive as a promise in
 * Next 15, so they are awaited here rather than in every route file.
 */
export async function handle(
  req: Request,
  ctx: { params?: Promise<Record<string, string>> } | undefined,
  handler: Handler,
): Promise<NextResponse> {
  try {
    const [session, params, body] = await Promise.all([
      currentSession(),
      ctx?.params ?? Promise.resolve({}),
      readBody(req),
    ]);
    const headers = Object.fromEntries(req.headers.entries());
    return toResponse(await handler({ session, params: normaliseParams(params), body, headers }));
  } catch (err) {
    // A typed `{ status, code }` throw is a client error the boundary itself
    // raised — today only the malformed-identifier 400 from normaliseParams
    // (LINA-79). Matched structurally, the same way every services/*/http.mjs
    // adapter does it, so it stays a 4xx instead of being logged as an outage.
    const e = err as { status?: number; code?: string; message?: string };
    if (typeof e?.status === 'number' && typeof e?.code === 'string' && e.status < 500) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message ?? 'bad request' } },
        { status: e.status },
      );
    }
    // Anything else is a wiring/config failure (e.g. a missing DATABASE_URL), not
    // a domain error — the service handlers map those themselves. Log it for the
    // server operator; return nothing that could leak connection detail.
    console.error('[api] unhandled route failure', err);
    return NextResponse.json(
      { error: { code: 'internal', message: 'internal error' } },
      { status: 500 },
    );
  } finally {
    // THE FLUSH (LINA-58). The PostHog sink buffers captures and ships them in
    // one batched POST; Vercel can freeze the instance the moment the response
    // is written, so an unflushed buffer is a silently dropped batch. Every API
    // route funnels through this one function, which is why the flush lives here
    // and not in each route's discipline.
    //
    // `finally`, not the success path: a 4xx/5xx has usually emitted the MORE
    // interesting events, and losing exactly the failure telemetry would be the
    // worst possible sampling bias.
    //
    // Read from the analytics singleton rather than the container, so a request
    // that failed because the container could not be built (missing
    // DATABASE_URL) still flushes instead of throwing a second time. Analytics
    // is best-effort by contract — `flush()` swallows sink errors — and the
    // extra catch keeps that true if a future sink throws synchronously.
    try {
      await getAnalytics().flush();
    } catch (flushErr) {
      console.warn('[api] analytics flush failed', flushErr);
    }
  }
}
