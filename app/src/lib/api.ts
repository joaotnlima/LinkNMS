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
// path is not a privilege shortcut. The acting party comes from the signed
// session cookie and nothing else.
import { cookies } from 'next/headers';

import { getContainer } from '@services/gateway/container.mjs';
import { SESSION_COOKIE, verifySession } from '@services/identity/session.mjs';

import type { Project, Decision, ChangeOrderDetail, ChangeOrderSummary, AuditResult, Pillars } from './types';
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
  inviteCounterparty: {
    method: 'POST', path: (p) => `/projects/${enc(p.id)}/invitations`,
    handler: (c) => c.http.identity.inviteCounterparty,
  },
  acceptInvitation: {
    method: 'POST', path: (p) => `/invitations/${enc(p.token)}/accept`,
    handler: (c) => c.http.identity.acceptInvitation,
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

/** The acting party, read ONLY from the signed httpOnly cookie (ADR-0004). */
async function session(): Promise<{ partyId: string } | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return (verifySession(raw) as { partyId: string } | null) ?? null;
}

export async function isSignedIn(): Promise<boolean> {
  return (await session()) !== null;
}

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
  const s = await session();
  // Fail before the round trip: every one of these endpoints is members-only, so
  // an anonymous caller is a redirect to sign-in, not a 403 rendered as a crash.
  if (!s) throw new UnauthenticatedError();

  const result = isRemote()
    ? await callHttp(route, params, body)
    : await route.handler(getContainer())({ session: s, params: withAliases(params), body, headers: {} });

  if (result.status >= 400) raise(result.status, result.body);
  return result.body as T;
}

// The service handlers name the project param `projectId`; the Next segment is
// `[id]`. app/src/server/gateway.ts normalises both directions for the HTTP
// routes — the in-process transport bypasses that file, so it must do the same
// thing here or a handler reads `undefined` and returns a perfectly plausible
// 403 on the owner's own project.
function withAliases(params: Params): Params {
  const out = { ...params };
  if (out.id && !out.projectId) out.projectId = out.id;
  if (out.projectId && !out.id) out.id = out.projectId;
  return out;
}

async function callHttp(route: Op, params: Params, body: unknown): Promise<{ status: number; body?: unknown }> {
  const jar = await cookies();
  const res = await fetch(`${API_BASE}/api/v1${route.path(params)}`, {
    method: route.method,
    headers: {
      accept: 'application/json',
      // Forward the session verbatim: the remote gateway re-verifies the
      // signature, so this transport grants nothing the caller did not have.
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
): Promise<ChangeOrderDetail & { projectedIfApprovedCents: number | null }> {
  const wire = await call<WireChangeOrder>('getChangeOrder', { changeOrderId: id });
  const dir = await directory(wire.projectId);
  return { ...toChangeOrderDetail(wire, dir), projectedIfApprovedCents: projectedIfApproved(wire) };
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

/**
 * FR1, second half. The raw invitation token comes back EXACTLY ONCE and is
 * never persisted — the caller must show it to the inviter immediately, and it
 * must never be logged or written to analytics.
 */
export async function inviteCounterparty(projectId: string): Promise<{ token: string }> {
  const res = await call<{ token: string; invitation: { id: string } }>(
    'inviteCounterparty', { id: projectId }, { role: 'counterparty' },
  );
  return { token: res.token };
}

export async function acceptInvitation(token: string): Promise<{ projectId: string }> {
  const res = await call<{ membership: { projectId: string } }>('acceptInvitation', { token });
  return { projectId: res.membership.projectId };
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
