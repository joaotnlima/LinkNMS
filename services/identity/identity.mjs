// Identity & Membership service (LINA-37, Slice 2) — the typed internal interface
// every other service and the API layer call (ADR-0006 §2). It is the SOLE
// authorizer (ADR-0004): the pure decision lives in ./authz.mjs `can(...)`; this
// module wraps it with the server-side membership lookup so the acting party is
// ALWAYS derived from the session and never trusted from the request body.
//
// Ownership: schema `identity` (project, membership, invitation, party). It never
// reads another schema — the budget summary on GET /projects/:id comes through
// the Ledger port (ADR-0006 §1), never a cross-schema join.
//
// Every mutation is a projection write + a hash-chained ledger append committed in
// ONE unit of work (store.transaction). Identity emits two event types, both known
// to the audit view: `project_created` (genesis, carries the baseline) and
// `member_joined` (the counterparty accepts). The owner's own membership is implied
// by project_created's actor, so it gets no separate member_joined. Issuing an
// invitation writes no ledger event — a pending token is not project history.

import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { can, ACTION } from './authz.mjs';
import { badRequest, conflict, forbidden, notFound, unauthenticated } from './errors.mjs';
import { createNoopAnalytics } from '../analytics/analytics.mjs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

// Default id/token/clock providers — injectable so tests are deterministic.
const defaultIds = { uuid: () => randomUUID(), token: () => randomBytes(24).toString('base64url') };
const defaultClock = { now: () => new Date().toISOString() };

const MAX_NAME = 200;

/**
 * @param {Object} deps
 * @param {ReturnType<import('./store.mjs').createMemoryStore>} deps.store
 * @param {{ budgetSummary(projectId): Promise<any>|any }} deps.ledger  Ledger port
 * @param {{ uuid():string, token():string }} [deps.ids]
 * @param {{ now():string }} [deps.clock]
 */
export function createIdentityService({ store, ledger, ids = defaultIds, clock = defaultClock, analytics = createNoopAnalytics() }) {
  if (!store) throw new Error('identity service requires a store');
  if (!ledger) throw new Error('identity service requires a ledger port');

  // ── The authorizer (ADR-0004) ───────────────────────────────────────────────

  // The one role lookup: a party's role on a project, or null when they are not a
  // member. Every capability decision derives from this — never from the client.
  // Async because the store is async in production (Postgres); awaiting a sync
  // in-memory result is harmless, so both adapters share this code path.
  async function roleOf(projectId, partyId) {
    if (!partyId) return null;
    const m = await store.getMembership(projectId, partyId);
    return m ? m.role : null;
  }

  // The sole authorization gate every mutating handler (here and in sibling
  // services) calls FIRST. Establishes who the party is from the session, looks up
  // their role server-side, and runs the pure `can(...)` decision. Throws typed
  // errors so the API layer maps them without re-classifying:
  //   401 no acting party · 403 not-a-member / capability denied.
  // Returns { role } so the caller can branch without a second lookup.
  async function authorize({ actorPartyId, action, projectId, ...extra }) {
    if (!actorPartyId) throw unauthenticated();
    const role = action === ACTION.CREATE_PROJECT ? null : await roleOf(projectId, actorPartyId);
    const decision = can({ action, role, actorPartyId, ...extra });
    if (!decision.allow) {
      // "not a member" and every capability denial are a 403 — we know who you are
      // and you may not. Unknown-party is the only 401, handled above.
      throw forbidden(decision.reason);
    }
    return { role };
  }

  // Cross-service convenience matching the port sibling services consume
  // (see services/change_order/ports.mjs `createInMemoryIdentity`). Any member
  // passes; a non-member is a 403. Role-specific rules stay in `can`.
  async function requireMember(partyId, projectId) {
    if (!partyId) throw unauthenticated('acting party is required');
    const role = await roleOf(projectId, partyId);
    if (!role) throw forbidden('acting party is not a member of this project');
    return { partyId, projectId, role };
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  // POST /projects — the homeowner starts a shared record and becomes its owner
  // (FR1). No prior membership needed; the creator is written as the `owner`
  // membership in the same unit as the project_created genesis event.
  async function createProject({ actorPartyId, name, baselineBudgetCents }) {
    await authorize({ actorPartyId, action: ACTION.CREATE_PROJECT });

    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) throw badRequest('name is required');
    if (cleanName.length > MAX_NAME) throw badRequest(`name exceeds ${MAX_NAME} chars`);
    const baseline = normalizeCents(baselineBudgetCents, 'baselineBudgetCents');

    const now = clock.now();
    const project = {
      id: ids.uuid(),
      name: cleanName,
      ownerPartyId: actorPartyId,
      baselineBudgetCents: baseline,
      createdAt: now,
    };
    const ownerMembership = {
      id: ids.uuid(),
      projectId: project.id,
      partyId: actorPartyId,
      role: 'owner',
      joinedAt: now,
    };

    await store.transaction(async (tx) => {
      await tx.insertProject(project);
      await tx.insertMembership(ownerMembership);
      await tx.appendEvent({
        projectId: project.id,
        type: 'project_created',
        actorPartyId,
        occurredAt: now,
        // Baseline rides the genesis payload so the authoritative budget is
        // computed ledger-side (design §5); Identity never re-sums budget rows.
        payload: { name: cleanName, baselineBudgetCents: baseline, ownerPartyId: actorPartyId },
      });
    });

    // Analytics is emitted AFTER the unit of work commits, so exactly one event
    // per committed project — a rolled-back transaction fires nothing (§2.4).
    // Server-side: distinct_id is the authenticated owner, never client-supplied.
    analytics.projectCreated({
      projectId: project.id,
      actorPartyId,
      baselineBudgetCents: baseline,
      createdAt: now,
    });

    return shapeProject(project, [ownerMembership], {
      baselineBudgetCents: baseline,
      currentBudgetCents: baseline,
    }, 'owner');
  }

  // GET /projects/:id — members only. Returns the identity-owned view: project +
  // memberships + budget summary (the summary comes through the Ledger port, never
  // a cross-schema read). Pillars/counts are composed by the API route from the
  // Ledger/Decision/Change-Order services (other slices), not here.
  async function getProject({ actorPartyId, projectId }) {
    const { role } = await authorize({ actorPartyId, action: ACTION.VIEW_PROJECT, projectId });
    const project = await store.getProject(projectId);
    if (!project) throw notFound('project'); // member of a vanished project — defensive
    const members = await store.listMemberships(projectId);
    const budget = (await ledger.budgetSummary(projectId)) ?? {
      baselineBudgetCents: project.baselineBudgetCents,
      currentBudgetCents: project.baselineBudgetCents,
    };
    return shapeProject(project, members, budget, role);
  }

  // POST /projects/:id/invitations — owner-only (FR1). Mints a single-use token,
  // stores only its SHA-256, and returns the RAW token exactly once (never
  // persisted, never logged) for the inviter to deliver out of band.
  async function inviteCounterparty({ actorPartyId, projectId, role = 'counterparty' }) {
    await authorize({ actorPartyId, action: ACTION.INVITE_COUNTERPARTY, projectId });
    if (role !== 'counterparty') throw badRequest('R0 invites the counterparty role only');
    if (!(await store.getProject(projectId))) throw notFound('project');

    // Fast, clean 409s before minting a token: a counterparty already joined, or an
    // invite is already pending. (The DB UNIQUEs are the ultimate backstop.)
    if ((await store.listMemberships(projectId)).some((m) => m.role === 'counterparty')) {
      throw conflict('project already has a counterparty');
    }
    if ((await store.listPendingInvitations(projectId)).length > 0) {
      throw conflict('project already has a pending invitation');
    }

    const rawToken = ids.token();
    const invitation = {
      id: ids.uuid(),
      projectId,
      tokenHash: sha256Hex(rawToken),
      role: 'counterparty',
      status: 'pending',
      invitedByPartyId: actorPartyId,
      createdAt: clock.now(),
      acceptedAt: null,
    };

    let stored;
    await store.transaction(async (tx) => {
      stored = await tx.insertInvitation(invitation);
    });
    // gc_invited — the owner opened the invite. No token/PII in the payload;
    // only the invite method (R0 = single-use link).
    analytics.gcInvited({ projectId, actorPartyId, actorRole: 'owner' });

    // The raw token is returned ONCE and never stored. Callers must not log it.
    return { invitation: shapeInvitation(stored), token: rawToken };
  }

  // POST /invitations/:token/accept — the invited GC joins. The acting party is the
  // accepting session; the token proves the invitation, the session says who joins.
  // Marks the invite accepted and writes the counterparty membership + member_joined
  // event in one unit. Idempotent-safe: a re-accept of a spent token is a 409.
  async function acceptInvitation({ actorPartyId, token }) {
    if (!actorPartyId) throw unauthenticated();
    if (!token || typeof token !== 'string') throw badRequest('token is required');

    const tokenHash = sha256Hex(token);
    const now = clock.now();
    let membership;

    await store.transaction(async (tx) => {
      // Re-read under the unit so a concurrent accept cannot double-spend the token.
      const inv = await tx.getInvitationByTokenHash(tokenHash);
      if (!inv) throw notFound('invitation');
      if (inv.status !== 'pending') throw conflict('invitation has already been accepted');

      membership = {
        id: ids.uuid(),
        projectId: inv.projectId,
        partyId: actorPartyId,
        role: inv.role, // 'counterparty' in R0
        joinedAt: now,
      };
      // insertMembership enforces UNIQUE(project,role) & UNIQUE(project,party): a
      // second counterparty or a self-join by an existing member is a clean 409.
      await tx.insertMembership(membership);
      await tx.markInvitationAccepted(inv.id, now);
      await tx.appendEvent({
        projectId: inv.projectId,
        type: 'member_joined',
        actorPartyId,
        occurredAt: now,
        payload: { partyId: actorPartyId, role: membership.role },
      });
    });

    // gc_joined — the second party is now on the record (the activation moment).
    // hours_since_created is a server-clock delta from the project genesis, so we
    // read the project's created_at (own schema, no cross-schema join).
    const joinedProject = await store.getProject(membership.projectId);
    analytics.gcJoined({
      projectId: membership.projectId,
      actorPartyId,
      projectCreatedAt: joinedProject?.createdAt ?? now,
      joinedAt: now,
    });

    return { membership: shapeMembership(membership) };
  }

  return {
    // authorizer (the sole gate)
    authorize,
    roleOf,
    requireMember,
    can, // re-export the pure decision for callers/tests
    // handlers
    createProject,
    getProject,
    inviteCounterparty,
    acceptInvitation,
  };
}

// ── Validation + response shaping ──────────────────────────────────────────────

// Money is integer cents, always — never a float, never negative for a baseline.
function normalizeCents(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest(`${field} must be an integer number of cents`);
  }
  if (!Number.isInteger(value)) throw badRequest(`${field} must be integer cents, not a fraction`);
  if (value < 0) throw badRequest(`${field} must not be negative`);
  return value;
}

function shapeMembership(m) {
  return { id: m.id, projectId: m.projectId, partyId: m.partyId, role: m.role, joinedAt: m.joinedAt };
}

function shapeInvitation(i) {
  return {
    id: i.id,
    projectId: i.projectId,
    role: i.role,
    status: i.status,
    createdAt: i.createdAt,
    // token_hash is deliberately never returned; the raw token is returned once,
    // separately, by inviteCounterparty.
  };
}

function shapeProject(project, memberships, budget, actingRole) {
  return {
    id: project.id,
    name: project.name,
    ownerPartyId: project.ownerPartyId,
    baselineBudgetCents: budget?.baselineBudgetCents ?? project.baselineBudgetCents,
    currentBudgetCents: budget?.currentBudgetCents ?? project.baselineBudgetCents,
    actingRole, // derived server-side from the session (never the body)
    createdAt: project.createdAt,
    // `displayName` is null when the store did not join identity.party (the
    // in-memory store, and the freshly-built owner membership createProject
    // returns before any read). Null, not a fabricated name: the UI renders
    // "Unknown party" rather than inventing an attribution, which on a record
    // whose whole promise is "who decided this" is the only honest fallback.
    members: memberships.map((m) => ({
      partyId: m.partyId,
      role: m.role,
      joinedAt: m.joinedAt,
      displayName: m.displayName ?? null,
    })),
  };
}
