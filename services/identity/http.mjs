// Identity & Membership — HTTP route handlers for the openapi.yaml
// endpoints (create project / get project / set operating model / invite /
// accept / me), LINA-56 / ADR-0004.
//
// Framework-agnostic, same shape as services/change_order/http.mjs and
// services/decision/http.mjs: `{ session, params, body }` in, `{ status, body }`
// out, plus an optional `headers` for the one response that needs them. Making
// FR1 reachable is the point of this module — without it a user cannot create a
// project or invite the GC at all, and nothing downstream is demonstrable.
//
// THE security property (ADR-0004): the acting party is ALWAYS `session.partyId`.
// `createProject` takes only name + baseline from the body; `ownerPartyId` is the
// session's, so a body claiming to create a project owned by someone else is
// inert. `acceptInvitation` takes the token from the PATH and the joining party
// from the SESSION — the token proves the invitation, the session says who joins.
//
// The raw invitation token is returned exactly once, in the 201 body of
// inviteCounterparty. It is never persisted (only its SHA-256 is) and must never
// be logged — hence `cache-control: no-store` on that response.
import { IdentityError, badRequest, tooManyRequests } from './errors.mjs';
import { createRateLimiter, sha256Hex } from './rate-limit.mjs';
import { clientIpOf } from '../gateway/client-ip.mjs';

function errorBody(err) {
  if (err instanceof IdentityError || (err && typeof err.status === 'number' && typeof err.code === 'string')) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          // Only fieldError() sets this (account setup, LINA-189). Spread
          // conditionally so every other error body is byte-for-byte what it
          // was before rather than gaining a misleading `field: undefined`.
          ...(err.field ? { field: err.field } : {}),
          // Only the plan allowance sets these (LINA-189 / ADR-0013). The
          // portal needs the numbers to say "1 of 1 build used — upgrade to run
          // more" instead of a bare conflict, and re-deriving them client-side
          // would be a second, drifting copy of the pricing table. Same
          // conditional spread rule: every other error body is unchanged.
          ...(typeof err.limit === 'number'
            ? { plan: err.plan ?? null, limit: err.limit, owned: err.owned }
            : {}),
        },
      },
    };
  }
  // An unmapped throw is a bug or an infrastructure failure (a missing GRANT, a
  // dropped connection), never a client mistake. The response deliberately says
  // nothing — but a 500 that leaves no trace anywhere is undiagnosable in
  // production, so the real error goes to the server log.
  console.error('[identity] unhandled service error', err);
  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
}

const actorOf = (session) => session?.partyId ?? null;

// The public origin the invitation link is built against (LINA-84). Derived from
// the ENV override or the request's forwarded headers — NEVER from the request
// body. A body-supplied origin would let any authenticated owner mint an invite
// email, sent from our domain, whose "Accept" button points at a host they chose:
// a credential-phishing primitive wearing our brand. The same precedence the
// deleted magic-link sign-in route used (LINA-124 removed that route; the rule
// it established for deriving a public origin still governs this one).
function originOf(headers = {}, env = process.env) {
  if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/+$/, '');
  const h = (k) => headers?.[k] ?? headers?.[k.toLowerCase()] ?? null;
  const proto = h('x-forwarded-proto') ?? 'https';
  const host = h('x-forwarded-host') ?? h('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

/**
 * @param {Object} deps
 * @param {ReturnType<import('./identity.mjs').createIdentityService>} deps.service
 * @param {ReturnType<typeof createRateLimiter>} [deps.rateLimiter]  injected so tests can trip the window
 * @param {{ decisions(projectIds: string[]): Promise<Map<string, number>>, changeOrders(projectIds: string[]): Promise<Map<string, number>> }} [deps.counts]
 *   Batched count providers for the portfolio card (GET /projects, ADR-0012 §A1).
 *   Identity never reads a sibling schema, so the two folds live here at the
 *   composition seam — the container wires them to the decision/change-order
 *   stores' grouped `countProjects`. Absent → every card reads zero (the
 *   identity-only tests), which is honest: this handler cannot invent counts it
 *   has no port for, and the production container always supplies them.
 */
export function createIdentityHttp({ service, rateLimiter = createRateLimiter(), counts = null }) {
  if (!service) throw new Error('createIdentityHttp requires { service }');

  // POST /projects — FR1, first half: a shared record with a baseline budget.
  // `draft: true` selects the Band B wizard step-1 path (ADR-0011): the build row
  // is created `status='draft'` with no operating model; the legacy one-shot path
  // (no `draft`) behaves exactly as before. `draft` is a server-read boolean, and
  // the actor is still the session's — a body cannot forge the owner.
  async function createProject({ session, body }) {
    try {
      const project = await service.createProject({
        actorPartyId: actorOf(session),
        name: body?.name,
        baselineBudgetCents: body?.baselineBudgetCents,
        draft: Boolean(body?.draft),
        // Role screen (LINA-221, ADR-0016): 'owner' (default) or 'counterparty'
        // for a GC-created build. The service validates and defaults it, so a
        // missing key keeps the legacy owner-first behaviour.
        creatorRole: body?.creatorRole,
        // Basics descriptive fields (LINA-219). Body-supplied and optional; the
        // service trims/caps and stores null for blanks, so a missing key is fine.
        siteAddress: body?.siteAddress,
        buildType: body?.buildType,
        expectedStart: body?.expectedStart,
      });
      return { status: 201, body: project };
    } catch (err) { return errorBody(err); }
  }

  // GET /projects/:id — members only; carries the ledger-derived budget summary.
  async function getProject({ session, params }) {
    try {
      const project = await service.getProject({
        actorPartyId: actorOf(session),
        projectId: params.id,
      });
      return { status: 200, body: project };
    } catch (err) { return errorBody(err); }
  }

  // GET /projects — the portfolio list (LINA-197, ADR-0012 §A1): every build the
  // acting party is a member of, most-recent-first. Session-scoped (the party is
  // NEVER a query/body param), so one party's portfolio can never be another's.
  // `counts` is composed here from the injected batched folds — the service
  // cannot read siblings' schemas, and per-card list calls would be N+1.
  async function listProjects({ session }) {
    try {
      const actorsProjects = await service.listProjects({ actorPartyId: actorOf(session) });
      if (actorsProjects.length === 0) {
        return { status: 200, body: { projects: [] }, headers: { 'cache-control': 'no-store' } };
      }
      const ids = actorsProjects.map((p) => p.id);
      const [decisionCounts, changeOrderCounts] = await Promise.all([
        counts?.decisions(ids) ?? Promise.resolve(new Map()),
        counts?.changeOrders(ids) ?? Promise.resolve(new Map()),
      ]);
      return {
        status: 200,
        // Personal payload, scoped to the session — a shared cache must never
        // hand one party's portfolio to another (same rule as GET /me).
        headers: { 'cache-control': 'no-store' },
        body: {
          projects: actorsProjects.map((p) => ({
            ...p,
            counts: {
              changeOrders: changeOrderCounts.get(p.id) ?? 0,
              decisions: decisionCounts.get(p.id) ?? 0,
            },
          })),
        },
      };
    } catch (err) { return errorBody(err); }
  }

  // POST /projects/:id/invitations — FR1, second half: invite the party the
  // build's operating model admits. Owner-only. The 201 body carries the raw
  // token ONCE; it is not stored. `email` is optional (LINA-84): present → the
  // link is mailed and the body reports `emailed`; absent → unchanged, the owner
  // delivers the token out of band. The first invite on a draft commits the build
  // (draft→active, a ledger event) — see the service unit of work.
  async function inviteCounterparty({ session, params, body, headers }) {
    try {
      const result = await service.inviteCounterparty({
        actorPartyId: actorOf(session),
        projectId: params.id,
        role: body?.role ?? 'counterparty',
        email: body?.email,
        // The pen's Invite screen descriptive fields (LINA-222); both optional.
        inviteeName: body?.inviteeName,
        scopeNote: body?.scopeNote,
        baseUrl: originOf(headers),
      });
      return {
        status: 201,
        body: result,
        // The single-use token must never land in a shared or browser cache.
        headers: { 'cache-control': 'no-store' },
      };
    } catch (err) { return errorBody(err); }
  }

  // PATCH /projects/:id/operating-model — Band B wizard step 2 (ADR-0011).
  // Owner-only; sets the operating model on a draft. The body's operatingModel
  // must be one of {turnkey, direct, hybrid} or the service returns a typed 400.
  // Response is the updated project view so the wizard can advance without a
  // second GET.
  async function setOperatingModel({ session, params, body }) {
    try {
      const project = await service.setOperatingModel({
        actorPartyId: actorOf(session),
        projectId: params.id,
        operatingModel: body?.operatingModel,
      });
      return { status: 200, body: project };
    } catch (err) { return errorBody(err); }
  }

  // POST /invitations/:token/accept — the invited party joins. The acting party is the
  // accepting session; the token proves the invitation, the session says who joins.
  async function acceptInvitation({ session, params }) {
    try {
      const result = await service.acceptInvitation({
        actorPartyId: actorOf(session),
        token: params.token,
      });
      return { status: 200, body: result, headers: { 'cache-control': 'no-store' } };
    } catch (err) { return errorBody(err); }
  }

  // GET /invitations/:token — the ONE unauthenticated read on the record
  // (LINA-182), powering the Band B accept deep link (M6/D6). No session is
  // required or wanted: a signed-out visitor carries only the token, and that
  // token IS the credential for this read (see the service note on the
  // disclosure reasoning in identity.mjs).
  //
  // RATE LIMITING (a transport concern, so it lives here): two buckets per
  // request — the token-hash keyed one throttles burning one leaked token from
  // many IPs; the client-IP one applies ADR-0007 §4's per-IP discipline to the
  // aggregate of token-rotation attempts from a single source. Both must pass;
  // the token bucket always bites (hashing needs no header), the IP bucket only
  // when a trustworthy hop is present. This is the ONLY unauthenticated read of
  // a token-keyed row, and unknown/spent tokens already return a uniform 404 —
  // the limiter throttles the residual brute-force burst, it is not the primary
  // control.
  //
  // cache-control: no-store — the payload carries a personal address; a shared
  // cache must never hand one visitor's invite preview to another.
  async function previewInvitation({ params, headers }) {
    const token = params?.token;
    try {
      if (typeof token !== 'string' || !token) throw badRequest('token is required');
      const tokenHash = sha256Hex(token);
      const ip = clientIpOf(headers);
      if (rateLimiter.overLimit(`invite-preview:${tokenHash}`)
          || (ip && rateLimiter.overLimit(`invite-preview-ip:${ip}`))) {
        throw tooManyRequests();
      }
      const result = await service.previewInvitation({ token });
      return { status: 200, body: result, headers: { 'cache-control': 'no-store' } };
    } catch (err) { return errorBody(err); }
  }

  // GET /me — the authenticated party's own profile. Per-user, session-scoped:
  // cache-control: no-store so a shared cache never hands one party's identity
  // to another.
  async function getMe({ session }) {
    try {
      const me = await service.getMe({
        actorPartyId: actorOf(session),
      });
      return { status: 200, body: me, headers: { 'cache-control': 'no-store' } };
    } catch (err) { return errorBody(err); }
  }

  // POST /me/profile — first-login account setup (LINA-189). Self-only: the
  // party is the session's and there is no id in the path or body to point
  // elsewhere. no-store for the same reason GET /me has it — the response
  // carries a personal display name, and a shared cache must never hand one
  // party's setup confirmation to another.
  async function completeProfile({ session, body }) {
    try {
      const profile = await service.completeProfile({
        actorPartyId: actorOf(session),
        displayName: body?.displayName,
        role: body?.role,
        language: body?.language,
      });
      return { status: 200, body: { profile }, headers: { 'cache-control': 'no-store' } };
    } catch (err) { return errorBody(err); }
  }

  return {
    createProject, getProject, listProjects, setOperatingModel, inviteCounterparty,
    acceptInvitation, previewInvitation, getMe, completeProfile,
  };
}
