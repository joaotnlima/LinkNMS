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

// A multipart upload the transport parsed for a handler that wants a file
// rather than a JSON body (LINA-206 plan import). The browser sends bytes only;
// the service re-derives everything from `buffer` server-side (contract §0).
export interface UploadFile {
  filename: string;
  buffer: Buffer;
  sheet?: string;
  mapping?: unknown;
  idempotencyKey?: string;
}

export type Handler = (ctx: {
  session: Session | null;
  params: Record<string, string>;
  body: unknown;
  file?: UploadFile;
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

// Parse a `multipart/form-data` upload into the `file` a service handler reads.
// Fields: `file` (the .xlsx part), `sheet`, `mapping` (a JSON string), and
// `idempotencyKey`. Everything is optional here — the SERVICE validates presence
// and shape and returns the typed 400 (one validation story, like readBody). A
// non-multipart or malformed body yields an empty file, which the service then
// rejects (e.g. empty_file / invalid_sheet) rather than crashing.
async function readUpload(req: Request): Promise<UploadFile> {
  const file: UploadFile = { filename: '', buffer: Buffer.alloc(0) };
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return file;
  }
  const part = form.get('file');
  if (part && typeof part === 'object' && 'arrayBuffer' in part) {
    file.filename = (part as File).name ?? '';
    file.buffer = Buffer.from(await (part as File).arrayBuffer());
  }
  const sheet = form.get('sheet');
  if (typeof sheet === 'string') file.sheet = sheet;
  const idempotencyKey = form.get('idempotencyKey');
  if (typeof idempotencyKey === 'string') file.idempotencyKey = idempotencyKey;
  const mapping = form.get('mapping');
  if (typeof mapping === 'string') {
    // Leave a malformed mapping as the raw string so the parser's normalizeMapping
    // returns the typed `invalid_mapping` 400 instead of a boundary crash.
    try { file.mapping = JSON.parse(mapping); } catch { file.mapping = mapping; }
  }
  return file;
}

function toResponse(result: HandlerResult): NextResponse {
  if (result.status === 304 || result.body === null || result.body === undefined) {
    return new NextResponse(null, { status: result.status, headers: result.headers });
  }
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

/**
 * Run a service handler for a Next route. Route params arrive as a promise in
 * Next 15, so they are awaited here rather than in every route file. `buildInput`
 * chooses the transport: a JSON body (`handle`) or a multipart upload
 * (`handleUpload`) — everything else (session, params, the flush, the typed-error
 * boundary) is identical, so it lives here once.
 */
async function run(
  req: Request,
  ctx: { params?: Promise<Record<string, string>> } | undefined,
  handler: Handler,
  buildInput: (req: Request) => Promise<{ body?: unknown; file?: UploadFile }>,
): Promise<NextResponse> {
  try {
    const [session, params, input] = await Promise.all([
      currentSession(),
      ctx?.params ?? Promise.resolve({}),
      buildInput(req),
    ]);
    const headers = Object.fromEntries(req.headers.entries());
    return toResponse(await handler({
      session, params: normaliseParams(params), headers,
      body: input.body, file: input.file,
    }));
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

// The JSON-body transport — every route file except the plan-import uploads.
export function handle(
  req: Request,
  ctx: { params?: Promise<Record<string, string>> } | undefined,
  handler: Handler,
): Promise<NextResponse> {
  return run(req, ctx, handler, async (r) => ({ body: await readBody(r) }));
}

// The multipart-upload transport (LINA-206): the .xlsx bytes + sheet/mapping/key
// arrive as form-data, reach the handler as `file`, and the service re-parses
// server-side. Nothing about the file is trusted here (contract §0).
export function handleUpload(
  req: Request,
  ctx: { params?: Promise<Record<string, string>> } | undefined,
  handler: Handler,
): Promise<NextResponse> {
  return run(req, ctx, handler, async (r) => ({ file: await readUpload(r) }));
}
