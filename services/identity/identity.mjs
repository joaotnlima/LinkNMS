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
import { IdentityError, badRequest, conflict, forbidden, notFound, unauthenticated } from './errors.mjs';
import { createNoopAnalytics } from '../analytics/analytics.mjs';
// The SAME normaliser the sign-in path uses, so an address typed into the invite
// form and the same address typed into the sign-in form are one key (LINA-84).
import { normalizeEmail } from './sign-in.mjs';
import { sendEmail, isEmailConfigured } from '../email/sender.mjs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

// The invitation email. Same visual language as the sign-in link (sign-in.mjs):
// inline-styled, self-contained, no tracking pixels and no external assets — an
// invite that renders as a broken-image box in a jobsite mail client is worse
// than plain text. `projectName` is the owner's own project name, so it is
// escaped rather than interpolated raw.
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function invitationEmailHtml({ link, projectName, inviterName }) {
  const who = inviterName ? `${escapeHtml(inviterName)} has` : 'You have been';
  const what = projectName ? `<strong>${escapeHtml(projectName)}</strong>` : 'their build';
  return `<!DOCTYPE html><html lang="en"><body style="margin:0;background:#f4f3f0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0b0b0b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fcfcfb;border:1px solid #dcdbd7;border-radius:12px;padding:32px">
      <tr><td style="font-weight:700;font-size:18px;letter-spacing:-.01em;padding-bottom:8px">LinkNMS <span style="color:#9a9a9a;font-weight:500;font-size:13px">Trust built-in.</span></td></tr>
      <tr><td style="font-size:20px;font-weight:600;padding:16px 0 8px">${who} invited you to ${what}</td></tr>
      <tr><td style="font-size:15px;line-height:1.5;color:#5b5b58;padding-bottom:24px">LinkNMS is the shared record of what was agreed, what changed, and what it cost. Accept below to join as the contractor on this build.</td></tr>
      <tr><td><a href="${link}" style="display:inline-block;background:#2a78d6;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 26px;border-radius:36px">Accept the invitation</a></td></tr>
      <tr><td style="font-size:12px;line-height:1.5;color:#9a9a9a;padding-top:28px;border-top:1px dashed #dcdbd7">This invitation can be accepted once. If you weren't expecting it, ignore this email.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

// Where the invited GC lands. The accept page already exists and reads the token
// from the query string (app/src/app/invitations/accept/page.tsx).
function buildInviteLink(baseUrl, rawToken) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/invitations/accept?token=${encodeURIComponent(rawToken)}`;
}

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
 * @param {{ send(msg,opts):Promise<any>, isConfigured(env):boolean }} [deps.sender]  email port (LINA-84)
 */
export function createIdentityService({
  store,
  ledger,
  ids = defaultIds,
  clock = defaultClock,
  analytics = createNoopAnalytics(),
  sender = { send: sendEmail, isConfigured: isEmailConfigured },
  env = process.env,
}) {
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
  //
  // LINA-84: `email` is OPTIONAL. Supplied → the address is stored (normalised)
  // and the link is mailed to the GC. Omitted → the pre-LINA-84 behaviour is
  // unchanged: no address, no send, and the raw token still comes back in the
  // 201 body for the owner to deliver out of band. Both paths return the token,
  // so mailing is strictly additive and a mail outage never strands the owner.
  //
  // NOT YET DONE HERE — the auto-seat of ADR-0008 §4. `identity.seat` does not
  // exist on any branch, so there is nothing to insert into; see the LINA-84
  // thread. When it lands, the seat row is inserted INSIDE the `store.transaction`
  // below (same unit of work as the invitation, per the brief) — the seam is
  // marked there.
  async function inviteCounterparty({ actorPartyId, projectId, role = 'counterparty', email, baseUrl }) {
    await authorize({ actorPartyId, action: ACTION.INVITE_COUNTERPARTY, projectId });
    if (role !== 'counterparty') throw badRequest('R0 invites the counterparty role only');
    const project = await store.getProject(projectId);
    if (!project) throw notFound('project');

    // An address was offered but is unusable → tell the OWNER plainly. This is not
    // the sign-in path: there is no enumeration concern here (the owner is
    // authenticated and authorised on their own project), and silently swallowing
    // a typo'd GC address is exactly the "invite vanished" failure this issue
    // exists to kill. `undefined`/empty means "out-of-band", not "malformed".
    const offered = typeof email === 'string' ? email.trim() : '';
    const cleanEmail = offered ? normalizeEmail(offered) : null;
    if (offered && !cleanEmail) throw badRequest('that does not look like an email address');

    // Fail closed BEFORE minting: if the deploy cannot send mail, an invite-by-email
    // must not report success having mailed nothing (same discipline as ADR-0007 §5).
    // The out-of-band path is unaffected — it never needed a mailer.
    if (cleanEmail && !sender.isConfigured(env)) {
      throw new IdentityError('email_unconfigured', 503, 'email delivery is not configured');
    }

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
      email: cleanEmail, // null on the out-of-band path
      role: 'counterparty',
      status: 'pending',
      invitedByPartyId: actorPartyId,
      createdAt: clock.now(),
      acceptedAt: null,
    };

    let stored;
    await store.transaction(async (tx) => {
      stored = await tx.insertInvitation(invitation);
      // ── ADR-0008 §4 seam (LINA-84 §2) ────────────────────────────────────────
      // The invite-sourced seat belongs HERE, in the same unit of work as the
      // invitation, so an invite can never commit without the seat that makes it
      // usable. Not written yet: `identity.seat` exists in ADR-0008 but in no
      // migration on any branch, and the INSERT grant is an open trust-boundary
      // question for the Architect. When both land:
      //   if (cleanEmail) await tx.insertSeat({ email: cleanEmail, source: 'invite' });
    });
    // gc_invited — the owner opened the invite. No token/PII in the payload;
    // only the invite method (R0 = single-use link) and now whether it was mailed.
    analytics.gcInvited({ projectId, actorPartyId, actorRole: 'owner', method: cleanEmail ? 'email' : 'link' });

    // Mail AFTER commit, deliberately: an invitation that exists but wasn't mailed
    // is recoverable (the owner still holds the token from the 201 body and can
    // resend), whereas a mail sent for a row that then rolled back is a live link
    // to nothing. A send failure therefore does NOT void the invitation — it
    // surfaces as `emailed: false` so the UI can fall back to the copyable link.
    let emailed = false;
    if (cleanEmail) {
      try {
        await sender.send(
          {
            to: cleanEmail,
            subject: `You've been invited to ${project.name} on LinkNMS`,
            html: invitationEmailHtml({
              link: buildInviteLink(baseUrl, rawToken),
              projectName: project.name,
              inviterName: (await store.getParty?.(actorPartyId))?.displayName ?? null,
            }),
          },
          { env },
        );
        emailed = true;
      } catch (err) {
        // Never log the raw token or the body — only that delivery failed.
        console.error('[identity] invitation email failed to send', err?.code ?? err?.message ?? 'unknown');
      }
    }

    // The raw token is returned ONCE and never stored. Callers must not log it.
    return { invitation: shapeInvitation(stored), token: rawToken, emailed };
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
    // The address the invite was sent to, or null on the out-of-band path. Safe
    // to return: the only reader is the owner who just typed it, on their own
    // project, behind the owner-only capability gate.
    email: i.email ?? null,
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
