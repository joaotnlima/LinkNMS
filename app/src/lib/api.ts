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

import type {
  Project, Decision, ChangeOrderDetail, ChangeOrderSummary, AuditResult, Pillars, MeProfile,
  OperatingModel, Role, InvitationPreview, ProjectSummary,
} from './types';
import {
  directoryOf, countsOf, toProject, toDecision, toChangeOrderSummary, toChangeOrderDetail,
  toAuditResult, projectedIfApproved,
  type Directory, type WireProject, type WireDecision, type WireChangeOrder, type WireAudit,
} from './view';

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
  getMe: {
    method: 'GET', path: () => '/me',
    handler: (c) => c.http.identity.getMe,
  },
  listProjects: {
    method: 'GET', path: () => '/projects',
    handler: (c) => c.http.identity.listProjects,
  },
  getProject: {
    method: 'GET', path: (p) => `/projects/${enc(p.id)}`,
    handler: (c) => c.http.identity.getProject,
  },
  getStatus: {
    method: 'GET', path: (p) => `/projects/${enc(p.id)}/status`,
    handler: (c) => c.http.ledger.getStatus,
  },
  listDecisions: {
    method: 'GET', path: (p) => `/projects/${enc(p.id)}/decisions`,
    handler: (c) => c.http.decision.listDecisions,
  },
  listChangeOrders: {
    method: 'GET', path: (p) => `/projects/${enc(p.id)}/change-orders`,
    handler: (c) => c.http.changeOrder.listChangeOrders,
  },
  getChangeOrder: {
    method: 'GET', path: (p) => `/change-orders/${enc(p.changeOrderId)}`,
    handler: (c) => c.http.changeOrder.getChangeOrder,
  },
  getAudit: {
    method: 'GET', path: (p) => `/projects/${enc(p.id)}/audit`,
    handler: (c) => c.http.ledger.getAudit,
  },
  createProject: {
    method: 'POST', path: () => '/projects',
    handler: (c) => c.http.identity.createProject,
  },
  setOperatingModel: {
    method: 'PATCH', path: (p) => `/projects/${enc(p.id)}/operating-model`,
    handler: (c) => c.http.identity.setOperatingModel,
  },
  inviteCounterparty: {
    method: 'POST', path: (p) => `/projects/${enc(p.id)}/invitations`,
    handler: (c) => c.http.identity.inviteCounterparty,
  },
  acceptInvitation: {
    method: 'POST', path: (p) => `/invitations/${enc(p.token)}/accept`,
    handler: (c) => c.http.identity.acceptInvitation,
  },
  previewInvitation: {
    method: 'GET', path: (p) => `/invitations/${enc(p.token)}`,
    handler: (c) => c.http.identity.previewInvitation,
  },
  recordDecision: {
    method: 'POST', path: (p) => `/projects/${enc(p.id)}/decisions`,
    handler: (c) => c.http.decision.recordDecision,
  },
  proposeChangeOrder: {
    method: 'POST', path: (p) => `/projects/${enc(p.id)}/change-orders`,
    handler: (c) => c.http.changeOrder.proposeChangeOrder,
  },
  decideChangeOrder: {
    method: 'POST', path: (p) => `/change-orders/${enc(p.changeOrderId)}/decision`,
    handler: (c) => c.http.changeOrder.decideChangeOrder,
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
  const e = (body as { error?: { code?: string; message?: string } })?.error;
  if (status === 401) throw new UnauthenticatedError();
  throw new ApiError(status, e?.message ?? `request failed (${status})`, e?.code ?? 'error');
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

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * GET /me — the authenticated party's own profile. The portal uses displayName
 * to greet the user by name (LINA-154). Returns the authoritative record from
 * identity.party; never derived client-side from the email.
 */
export async function getMe(): Promise<MeProfile> {
  return call<MeProfile>('getMe');
}

/**
 * GET /projects — the portfolio the home screen renders for a RETURNING user
 * (LINA-197 / ADR-0012 §A1). Membership-scoped to the acting party (the session,
 * never a query param), most-recent-first, drafts included so an abandoned
 * wizard is resumable. Budgets are ledger-authoritative (baseline + Σ approved
 * change orders) and the per-card counts arrive server-batched — nothing here
 * sums or counts.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const res = await call<{ projects: ProjectSummary[] }>('listProjects');
  return res.projects;
}

/**
 * The dashboard object. Four calls, because the R0 services are split by schema
 * and no single one of them owns this view: Identity has the project and its
 * members, the Ledger derives the four pillars, and the counts are a fold over
 * the decision and change-order lists.
 *
 * Issued concurrently — they are independent reads and the dashboard is the
 * screen a stressed owner opens first.
 */
export async function getProject(id: string): Promise<Project> {
  const [wire, pillars, decisions, changeOrders] = await Promise.all([
    call<WireProject>('getProject', { id }),
    call<Pillars>('getStatus', { id }),
    call<{ decisions: WireDecision[] }>('listDecisions', { id }),
    call<{ changeOrders: WireChangeOrder[] }>('listChangeOrders', { id }),
  ]);
  return toProject(wire, pillars, countsOf(decisions.decisions, changeOrders.changeOrders));
}

/** The member directory, needed by every surface that renders an attribution. */
async function directory(projectId: string): Promise<Directory> {
  return directoryOf(await call<WireProject>('getProject', { id: projectId }));
}

export async function getDecisions(projectId: string): Promise<Decision[]> {
  const [dir, list] = await Promise.all([
    directory(projectId),
    call<{ decisions: WireDecision[] }>('listDecisions', { id: projectId }),
  ]);
  return list.decisions.map((d) => toDecision(d, dir));
}

export async function getChangeOrders(projectId: string): Promise<ChangeOrderSummary[]> {
  const [dir, list] = await Promise.all([
    directory(projectId),
    call<{ changeOrders: WireChangeOrder[] }>('listChangeOrders', { id: projectId }),
  ]);
  return list.changeOrders.map((co) => toChangeOrderSummary(co, dir));
}

/** The FR6 one-screen answer. Also returns the projected total for a proposal —
 *  clearly separate from `budgetAfterCents`, which for a proposal has not moved. */
export async function getChangeOrder(
  id: string,
): Promise<ChangeOrderDetail & { projectId: string; projectedIfApprovedCents: number | null }> {
  const wire = await call<WireChangeOrder>('getChangeOrder', { changeOrderId: id });
  const dir = await directory(wire.projectId);
  // `projectId` is surfaced so the detail page resolves its build from the CO
  // record itself — never a hard-coded demo id (LINA-198 bugfix).
  return {
    ...toChangeOrderDetail(wire, dir),
    projectId: wire.projectId,
    projectedIfApprovedCents: projectedIfApproved(wire),
  };
}

export async function getAudit(projectId: string): Promise<AuditResult> {
  const [dir, wire] = await Promise.all([
    directory(projectId),
    call<WireAudit>('getAudit', { id: projectId }),
  ]);
  return toAuditResult(wire, dir);
}

// ── Writes (FR1 and the decision/change-order flows) ─────────────────────────

export async function createProject(input: { name: string; baselineBudgetCents: number }): Promise<{ id: string }> {
  return call<{ id: string }>('createProject', {}, input);
}

// ── Band B: the build-creation wizard (ADR-0011, LINA-179) ───────────────────

/**
 * The wizard's own read. `getProject()` above composes FOUR calls — identity plus
 * the ledger's pillars and both list folds — because that is what the dashboard
 * needs. A wizard step needs the build's name, status and operating model and
 * nothing else, and issuing three extra reads against a build with no decisions,
 * no change orders and no second party yet would be three round trips to derive
 * four "nothing here" pillars.
 *
 * Returns the wire shape rather than the composed `Project`: there are no pillars
 * or counts to compose, and manufacturing empty ones would put a screen-shaped
 * object in circulation that says "cost: green" about a build nobody has agreed
 * anything on.
 */
export async function getBuild(id: string): Promise<WireProject> {
  return call<WireProject>('getProject', { id });
}

/**
 * Wizard step 1 (M2/D2). Creates the build row as `status='draft'` with no
 * operating model — the draft-first spine of ADR-0011 decision 2. The build is
 * real and owned from this moment; it becomes `active` only when step 3's first
 * invite commits it.
 */
export async function createBuildDraft(input: {
  name: string;
  baselineBudgetCents: number;
}): Promise<{ id: string }> {
  return call<{ id: string }>('createProject', {}, { ...input, draft: true });
}

/**
 * Wizard step 2 (M3/D3). Owner-only; the service rejects anything outside
 * {turnkey, direct, hybrid} and 409s once the build has committed — the choice is
 * "asked once, never again" (pen: Note — Operating model asked once), so it is not
 * editable after commit and this call is not a settings update.
 *
 * Returns the updated project view so the wizard advances without a second GET.
 */
export async function setOperatingModel(
  projectId: string,
  operatingModel: OperatingModel,
): Promise<WireProject> {
  return call<WireProject>('setOperatingModel', { id: projectId }, { operatingModel });
}

/**
 * FR1, second half. The raw invitation token comes back EXACTLY ONCE and is
 * never persisted — the caller must show it to the inviter immediately, and it
 * must never be logged or written to analytics.
 */
/**
 * Invite the one GC. `email` is optional (LINA-84): supplied, the server mails
 * the accept link and reports `emailed`; omitted, nothing is sent. The raw
 * single-use token comes back either way, so the owner always has a link to
 * hand over even when delivery fails.
 */
/**
 * `role` defaults to `counterparty` — the R0 behaviour and, since ADR-0011 §4,
 * the GC's unchanged name. Band B's Direct-to-specialty and Hybrid models pass
 * `subcontractor`. The service is the authority on which role THIS build's
 * operating model admits and 400s on a mismatch; sending the role we intend and
 * letting it rule is the point, because the alternative is the client deciding
 * who may join a record.
 */
export async function inviteCounterparty(
  projectId: string,
  email?: string,
  role: Exclude<Role, 'owner'> = 'counterparty',
): Promise<{ token: string; emailed: boolean }> {
  const res = await call<{ token: string; emailed?: boolean; invitation: { id: string } }>(
    'inviteCounterparty',
    { id: projectId },
    { role, ...(email ? { email } : {}) },
  );
  return { token: res.token, emailed: res.emailed === true };
}

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

export async function recordDecision(projectId: string, input: { title: string; body: string }): Promise<{ id: string }> {
  return call<{ id: string }>('recordDecision', { id: projectId }, input);
}

export async function proposeChangeOrder(
  projectId: string,
  input: {
    title: string; costDeltaCents: number;
    scopeImpactNote?: string; scheduleImpactDays?: number; scheduleImpactNote?: string;
    qualityFlag?: boolean; qualityNote?: string;
  },
): Promise<{ id: string }> {
  return call<{ id: string }>('proposeChangeOrder', { id: projectId }, input);
}

export async function decideChangeOrder(
  changeOrderId: string,
  input: { decision: 'approve' | 'reject'; title?: string; body?: string },
): Promise<{ id: string }> {
  return call<{ id: string }>('decideChangeOrder', { changeOrderId }, input);
}
