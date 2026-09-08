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
import {
  IdentityError, alreadySetup, badRequest, conflict, fieldError, forbidden, notFound, unauthenticated,
} from './errors.mjs';
import { createNoopAnalytics } from '../analytics/analytics.mjs';
// The SAME normaliser every Identity path uses, so an address typed into the
// invite form and the same address arriving from anywhere else are one key
// (LINA-84). It moved out of the deleted sign-in service in LINA-124.
import { normalizeEmail } from './email-normalize.mjs';
import { activeProjectLimit } from './plans.mjs';
import { sendEmail, isEmailConfigured } from '../email/sender.mjs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

// ── Account setup vocabulary (LINA-189) ──────────────────────────────────────
// The two personas the product sells to, mapped to the two party roles the
// record stores. `viewer` is deliberately NOT reachable from setup: it is an
// administrative state, not something a person can elect for themselves on the
// way in. See completeProfile() for why this mapping lives at this boundary.
const SETUP_ROLE_TO_PARTY_ROLE = Object.freeze({
  owner: 'owner',
  general_contractor: 'contractor',
});
const SETUP_LANGUAGES = new Set(['en', 'pt', 'es']);
// Bounded because it is rendered beside every decision this party ever records;
// an unbounded name is a layout attack on everyone else's audit view.
const MAX_DISPLAY_NAME = 200;

function validateDisplayName(raw) {
  if (typeof raw !== 'string') throw fieldError('displayName', 'displayName must be a string');
  const trimmed = raw.trim();
  if (!trimmed) throw fieldError('displayName', 'Tell us how you should appear on the record.');
  if (trimmed.length > MAX_DISPLAY_NAME) {
    throw fieldError('displayName', `displayName must be at most ${MAX_DISPLAY_NAME} characters`);
  }
  return trimmed;
}

function validateSetupRole(raw) {
  if (typeof raw !== 'string' || !Object.hasOwn(SETUP_ROLE_TO_PARTY_ROLE, raw)) {
    throw fieldError('role', 'Choose the role that fits you on this build.');
  }
  return raw;
}

function validateLanguage(raw) {
  if (typeof raw !== 'string' || !SETUP_LANGUAGES.has(raw)) {
    throw fieldError('language', 'language must be one of en, pt, es');
  }
  return raw;
}

// The invitation email. Same visual language the sign-in link used to carry:
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

// The three Band B operating models (ADR-0011 decision 1) and the launch role
// each may invite (design §7; migration 0009 widened the invitation.role CHECK to
// {counterparty, subcontractor} to admit this). A legacy project with
// operating_model NULL falls back to the R0 behaviour — the one GC counterparty.
const OPERATING_MODEL_ROLES = Object.freeze({
  turnkey: ['counterparty'],
  direct: ['subcontractor'],
  hybrid: ['counterparty', 'subcontractor'],
});

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
  // The entitlement port (ADR-0008 / ADR-0013). Read-only: `activeSeat(email)`
  // answers what this address bought, which decides how many builds it may run.
  //
  // OPTIONAL, and the omission is meaningful rather than lax: a composition with
  // no seat store is one that has no notion of seats at all (the in-memory unit
  // fixtures), and in such a world there is no entitlement to enforce — a limit
  // invented out of nothing would be a policy this service made up. Production
  // is the opposite case and wires it unconditionally in the composition root,
  // where a missing port is a hard error. See services/composition.mjs.
  seats = null,
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

  // ── The plan allowance (LINA-189 / ADR-0013) ───────────────────────────────
  //
  // "Up to 1 active project" has been printed on the pricing page since LINA-173
  // and enforced nowhere. This is where it becomes true.
  //
  // WHAT COUNTS. Builds this party OWNS — the pricing page's rule verbatim: "A
  // project counts towards your plan when your organisation is the Managing
  // Organisation. Collaborators are always free." So a sub, an inspector or an
  // architect invited onto somebody else's record consumes nothing, which is
  // load-bearing for the product: a shared record that charges you per person
  // you invite stops being shared.
  //
  // DRAFTS COUNT. A draft is a build the wizard has started; it holds a name and
  // a baseline and it is on the owner's portfolio. Excluding drafts would make
  // the allowance trivially avoidable — abandon at step 1, forever, for free —
  // and would also mean an owner at their limit could still fill the portfolio
  // with rows they cannot commit. Ending a draft is a deletion, not a discount.
  //
  // WHY IT READS THE SEAT AND NOT THE PARTY. The seat is the entitlement record
  // (ADR-0008) and it is keyed on email, which is what let the plan be written
  // at claim time, before this party existed. `party.email` is the same
  // normalised address the seat gate matched at sign-in, so this lookup can only
  // miss if the person is not seated at all — and an unseated caller never gets
  // a party in the first place (app/src/server/session.ts).
  async function requireProjectAllowance(actorPartyId) {
    if (!seats?.activeSeat) return; // no entitlement port composed — see the factory
    const party = await store.getParty(actorPartyId);
    if (!party) throw notFound('party');

    const seat = await seats.activeSeat(party.email);
    const limit = activeProjectLimit(seat?.plan ?? null);
    if (limit === null) return; // unlimited tier

    const mine = await store.listProjectsForParty(actorPartyId);
    const owned = mine.filter((p) => p.ownerPartyId === actorPartyId).length;
    if (owned < limit) return;

    // 409, not 403. A 403 says "you may never do this"; the honest statement is
    // "you already have as many as your plan runs", which is a collision with
    // reality that the caller resolves by upgrading or by closing a build. The
    // code is distinct so the portal can show an upgrade path rather than a
    // generic conflict banner, and the numbers ride along so it does not have to
    // re-derive them.
    const err = conflict(
      `this plan runs ${limit} active ${limit === 1 ? 'build' : 'builds'}; you already have ${owned}`,
    );
    err.code = 'plan_limit_reached';
    err.plan = seat?.plan ?? null;
    err.limit = limit;
    err.owned = owned;
    throw err;
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  // POST /projects — the homeowner starts a shared record and becomes its owner
  // (FR1). No prior membership needed; the creator is written as the `owner`
  // membership in the same unit as the project_created genesis event.
  //
  // Band B (ADR-0011, LINA-164): the wizard's step-1 POST passes `draft: true`,
  // which creates the build row as `status='draft'` with `operating_model=NULL`
  // (step 2 sets the model, step 3's first invite commits it). The legacy
  // one-shot path omits `draft`, so the row lands `status='active'` — the DB
  // default — exactly as before. `status` is stamped server-side in both paths
  // so the in-memory reference store and the pg adapter stay byte-consistent.
  async function createProject({ actorPartyId, name, baselineBudgetCents, draft = false }) {
    await authorize({ actorPartyId, action: ACTION.CREATE_PROJECT });

    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) throw badRequest('name is required');
    if (cleanName.length > MAX_NAME) throw badRequest(`name exceeds ${MAX_NAME} chars`);
    const baseline = normalizeCents(baselineBudgetCents, 'baselineBudgetCents');

    // The plan allowance (LINA-189 / ADR-0013). Checked AFTER authorization and
    // input validation and BEFORE any write: a refusal here must never be the
    // thing that tells an unauthenticated caller a party exists, and a malformed
    // request must be a 400 rather than a misleading "upgrade your plan".
    await requireProjectAllowance(actorPartyId);

    const now = clock.now();
    const project = {
      id: ids.uuid(),
      name: cleanName,
      ownerPartyId: actorPartyId,
      baselineBudgetCents: baseline,
      operatingModel: null, // a step-1 build has not chosen one yet (ADR-0011)
      status: draft ? 'draft' : 'active',
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
    await authorize({ actorPartyId, action: ACTION.VIEW_PROJECT, projectId });
    return readProjectView({ actorPartyId, projectId });
  }

  // The shared "project + memberships + budget" view used by GET /projects/:id and
  // by Band B mutations that must hand the wizard back the project it just moved.
  // The acting role is re-derived server-side so the response always says what
  // THIS session may do, never what the caller claimed.
  async function readProjectView({ actorPartyId, projectId }) {
    const project = await store.getProject(projectId);
    if (!project) throw notFound('project'); // member of a vanished project — defensive
    const members = await store.listMemberships(projectId);
    const budget = (await ledger.budgetSummary(projectId)) ?? {
      baselineBudgetCents: project.baselineBudgetCents,
      currentBudgetCents: project.baselineBudgetCents,
    };
    return shapeProject(project, members, budget, await roleOf(projectId, actorPartyId));
  }

  // GET /projects — the portfolio list (ADR-0012 §A1, LINA-197). Returns the
  // builds the acting party is a MEMBER of — owner or counterparty, draft or
  // active — most-recent-first, so a returning user's home screen is resumable
  // (an abandoned draft is badged `draft`, never hidden). The acting party is
  // the session's (`actorPartyId`); there is deliberately NO party/query param,
  // so a caller can only ever list their own portfolio — and never another
  // org's projects. Membership scoping is the STORE's join
  // (identity.membership → project), so "only my builds" is a data-shape
  // property, not an after-the-fact filter. Read-only: no ledger event.
  //
  // What this returns is the card MINUS `counts`: decisions/change-orders live in
  // sibling schemas that Identity must not read (ADR-0006 §1), so the HTTP
  // handler composes the two cheap batched count folds onto each card. Budget
  // comes through the Ledger port exactly as getProject reads it — baseline +
  // Σ approved change orders, authoritative and ledger-side.
  async function listProjects({ actorPartyId }) {
    if (!actorPartyId) throw unauthenticated();
    const rows = await store.listProjectsForParty(actorPartyId);
    if (rows.length === 0) return [];

    const budgets = await Promise.all(rows.map((p) => ledger.budgetSummary(p.id)));
    // The frozen contract orders most-recent-first; `updatedAt` is the record's
    // last activity (ledger head, falling back to creation), which is the honest
    // "what should surface first" for a returning user.
    return rows
      .map((p, i) => {
        const budget = budgets[i] ?? {
          baselineBudgetCents: p.baselineBudgetCents,
          currentBudgetCents: p.baselineBudgetCents,
        };
        // The acting role rides the row's members list (fetching it again would be
        // an N+1) — the acting party is a member by construction of the query.
        const role = p.members.find((m) => m.partyId === actorPartyId)?.role ?? null;
        return shapeProjectSummary(p, budget, role);
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  // PATCH /projects/:id/operating-model — the wizard's step 2 (ADR-0011).
  // Owner-only; sets operating_model ∈ {turnkey, direct, hybrid} on a DRAFT. The
  // projection write (column-scoped UPDATE grant from 0009) and the
  // `operating_model_set` ledger event commit in ONE unit — a chosen operating
  // model is part of the record, never a silent projection edit. Once the build
  // is committed (status 'active') the model is fixed; an idempotent re-PATCH of
  // the same value changes nothing and writes no event.
  async function setOperatingModel({ actorPartyId, projectId, operatingModel }) {
    await authorize({ actorPartyId, action: ACTION.SET_OPERATING_MODEL, projectId });
    if (!OPERATING_MODEL_ROLES[operatingModel]) {
      throw badRequest(`operatingModel must be one of ${Object.keys(OPERATING_MODEL_ROLES).join(', ')}`);
    }
    const project = await store.getProject(projectId);
    if (!project) throw notFound('project');
    if (project.status !== 'draft') {
      throw conflict('operating_model can only be set on a draft build');
    }
    if (project.operatingModel === operatingModel) {
      return readProjectView({ actorPartyId, projectId }); // unchanged, no event
    }

    const now = clock.now();
    await store.transaction(async (tx) => {
      await tx.updateProjectOperatingModel(projectId, operatingModel);
      await tx.appendEvent({
        projectId,
        type: 'operating_model_set',
        actorPartyId,
        occurredAt: now,
        payload: { operatingModel },
      });
    });

    return readProjectView({ actorPartyId, projectId });
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
    const project = await store.getProject(projectId);
    if (!project) throw notFound('project');

    // The role vocabulary widened with migration 0009 (ADR-0011 decision 4); which
    // specialities THIS build may invite follows its operating model. A legacy
    // project (operating_model NULL, created before Band B) keeps R0 behaviour:
    // the one GC counterparty.
    const allowedRoles = OPERATING_MODEL_ROLES[project.operatingModel] ?? ['counterparty'];
    if (!allowedRoles.includes(role)) {
      throw badRequest(
        project.operatingModel
          ? `operating model "${project.operatingModel}" does not permit inviting role "${role}"`
          : 'R0 invites the counterparty role only',
      );
    }
    // A draft build commits on its first invite (ADR-0011 decision 2), so the
    // wizard enforces "operating_model present before commit" at the service
    // layer: inviting against a model-less draft would commit a build with no
    // chosen model. State conflict (409), not a malformed request (400).
    if (project.status === 'draft' && !project.operatingModel) {
      throw conflict('operating_model must be set before committing the build');
    }

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

    // Fast, clean 409s before minting a token: a member already holds the role
    // being invited, or any invite is already pending. (The DB UNIQUEs are the
    // ultimate backstop. The pending check stays one-at-a-time for V1 per OQ-3 —
    // the per-role index in 0009 is the latch Hybrid V2 releases later.)
    if ((await store.listMemberships(projectId)).some((m) => m.role === role)) {
      throw conflict(`project already has a ${role}`);
    }
    if ((await store.listPendingInvitations(projectId)).length > 0) {
      throw conflict('project already has a pending invitation');
    }

    const now = clock.now();
    const rawToken = ids.token();
    const invitation = {
      id: ids.uuid(),
      projectId,
      tokenHash: sha256Hex(rawToken),
      email: cleanEmail, // null on the out-of-band path
      role,
      status: 'pending',
      invitedByPartyId: actorPartyId,
      createdAt: now,
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

      // Draft→active commit: the FIRST invite is what makes the build live, and
      // the flip is a ledger event in this same unit of work — never a silent
      // projection edit. Legacy/active projects skip the flip (and emit nothing);
      // only a draft commits here.
      if (project.status === 'draft') {
        await tx.updateProjectStatus(projectId, 'active');
        await tx.appendEvent({
          projectId,
          type: 'project_committed',
          actorPartyId,
          occurredAt: now,
          payload: { invitedRole: role },
        });
      }
    });
    // gc_invited — the owner opened the invite. No token/PII in the payload;
    // only the invite method (R0 = single-use link) and now whether it was mailed.
    // Band B's subcontractor invites are NOT reported here: `gc_invited` is
    // GC-session semantics and the build_creation surface/role enums are owned by
    // LINA-163 (still unmerged — do not fork the enum here).
    if (role === 'counterparty') {
      analytics.gcInvited({ projectId, actorPartyId, actorRole: 'owner', method: cleanEmail ? 'email' : 'link' });
    }

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
    // Only for the GC: the event and its `has_counterparty` group property are
    // counterparty semantics. A subcontractor join (Direct/Hybrid) is not
    // reported until LINA-163's build_creation surface lands — see inviteCounterparty.
    // hours_since_created is a server-clock delta from the project genesis, so we
    // read the project's created_at (own schema, no cross-schema join).
    if (membership.role === 'counterparty') {
      const joinedProject = await store.getProject(membership.projectId);
      analytics.gcJoined({
        projectId: membership.projectId,
        actorPartyId,
        projectCreatedAt: joinedProject?.createdAt ?? now,
        joinedAt: now,
      });
    }

    return { membership: shapeMembership(membership) };
  }

  // GET /invitations/:token — the ONE unauthenticated read on the record
  // (LINA-182). It powers the Band B accept deep link (M6/D6): a signed-out
  // visitor holding only the token must learn which build they were invited to,
  // who invited them, and which email the invitation was mailed to so the inline
  // Clerk sign-up can pre-fill it. There is deliberately NO session — the token
  // IS the credential for this read; requiring one would defeat the deep link.
  //
  // THE DISCLOSURE CALL. The token is already a bearer credential that admits
  // whoever holds it onto the record, so revealing the build name is not a new
  // disclosure. The inviter's display name and the invited email belong to the
  // SAME party the token was minted for — the invitee learning who invited them,
  // and pre-filling their OWN address, leaks no third party. Both are therefore
  // returned, and this reasoning is the standing rationale if the fields are
  // ever revisited.
  //
  // ANTI-ORACLE: an unknown token and an already-accepted (spent) token return
  // the IDENTICAL `notFound` 404, so this endpoint cannot be used to probe
  // whether an arbitrary string is a live token. Only a `pending` invitation is
  // ever revealed; `status` in the response is consequently always 'pending'.
  // (Transport-layer rate limiting lives in http.mjs — this is a framework-
  // agnostic service and carries no request headers.)
  async function previewInvitation({ token }) {
    if (!token || typeof token !== 'string') throw badRequest('token is required');

    const inv = await store.getInvitationByTokenHash(sha256Hex(token));
    if (!inv || inv.status !== 'pending') throw notFound('invitation');

    const project = await store.getProject(inv.projectId);
    const inviter = inv.invitedByPartyId ? await store.getParty?.(inv.invitedByPartyId) : null;
    return {
      projectName: project?.name ?? null,
      invitedByName: inviter?.displayName ?? null,
      role: inv.role,
      email: inv.email ?? null,
      status: inv.status,
    };
  }

  // GET /me — the acting party's own profile. No authorization beyond being
  // authenticated: every signed-in party may read their own identity. Returns
  // the authoritative display_name, email, and role from identity.party — the
  // same record the setup screen (LINA-132) writes to. Never returns a list;
  // there is exactly one answer per session.
  async function getMe({ actorPartyId }) {
    if (!actorPartyId) throw unauthenticated();
    const party = await store.getParty(actorPartyId);
    if (!party) throw notFound('party');
    return {
      partyId: party.id,
      displayName: party.displayName,
      email: party.email,
      role: party.role,
      language: party.language ?? null,
      // The portal needs this to know whether to send someone to /onboarding/setup
      // or straight to their record. Without it the only way to tell a finished
      // account from a fresh one is to guess from the display name.
      setupComplete: party.setupComplete === true,
    };
  }

  // POST /me/profile — first-login account setup (LINA-189, contract in
  // docs/architecture/api-me-profile-contract.md).
  //
  // ── WHY THE ROLES ARE TRANSLATED HERE ────────────────────────────────────────
  // The setup screen speaks the product's vocabulary — "Owner" and "General
  // contractor" — and identity.party's CHECK constraint speaks the record's:
  // owner | contractor | viewer. Those are two vocabularies for one idea, and
  // the translation has to live at exactly one boundary or the two drift. This
  // is that boundary. The screen never sends a storage value and the store never
  // sees a product one.
  //
  // ── WHY THIS GRANTS NOTHING ──────────────────────────────────────────────────
  // The client sends a role CHOICE. It is written to the party's default role,
  // which is a description of what this person does — it is NOT an entitlement
  // and confers no access to any build. Access is identity.membership, minted
  // only by creating a project or accepting an invitation, and every capability
  // check goes through the ADR-0004 authorizer against THAT. So a hand-crafted
  // POST claiming `owner` buys the sender exactly one thing: the word "owner"
  // next to their own name on a record they still cannot reach.
  //
  // Identity is `actorPartyId` — from the verified session, never the body. The
  // scope is self-only and there is deliberately no party id parameter: nothing
  // here can be pointed at somebody else's row.
  async function completeProfile({ actorPartyId, displayName, role, language }) {
    if (!actorPartyId) throw unauthenticated();

    const cleanName = validateDisplayName(displayName);
    const productRole = validateSetupRole(role);
    const cleanLanguage = validateLanguage(language);

    const result = await store.completeProfile({
      partyId: actorPartyId,
      displayName: cleanName,
      role: SETUP_ROLE_TO_PARTY_ROLE[productRole],
      language: cleanLanguage,
    });

    // A live session whose party row is gone is not a 404 to show the user — it
    // is a session that no longer means anything. Sending 401 makes the client
    // sign out and start over, which is the only recoverable action available.
    if (result.status === 'not_found') throw unauthenticated();
    if (result.status === 'already_setup') throw alreadySetup();

    // No analytics event. The analytics port here is a TYPED facade over the
    // LINA-55 eight-event spine (projectCreated / gcInvited / gcJoined / …),
    // not a generic capture(), and quietly adding a ninth event through an
    // untyped side door would bypass the shape and no-PII assertions that make
    // that spine safe. If account-setup completion is worth measuring, it gets
    // added to the contract first — landing already counts the claim.
    return { displayName: cleanName, role: productRole, language: cleanLanguage, setupComplete: true };
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
    listProjects,
    setOperatingModel,
    inviteCounterparty,
    acceptInvitation,
    previewInvitation,
    getMe,
    completeProfile,
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

// The portfolio card (GET /projects, ADR-0012 §A1) — a projection, NOT the full
// getProject payload. `role` is the ACTING party's role, derived server-side
// from their membership (never a body/query claim). `updatedAt` is the record's
// most-recent ledger activity from the Ledger port, falling back to the build's
// own creation when the ledger has nothing yet. `counts` is NOT set here:
// decisions/change-orders live in sibling schemas (ADR-0006 §1), so the HTTP
// handler composes those two batched folds onto the card.
function shapeProjectSummary(project, budget, role) {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    role,
    operatingModel: project.operatingModel ?? null,
    baselineBudgetCents: budget?.baselineBudgetCents ?? project.baselineBudgetCents,
    currentBudgetCents: budget?.currentBudgetCents ?? project.baselineBudgetCents,
    // The card shows ONE name per member. displayName is null only when the
    // store did not join identity.party (the freshly-built owner membership);
    // the UI renders "Unknown party" rather than inventing an attribution.
    members: (project.members ?? []).map((m) => ({
      role: m.role,
      name: m.displayName ?? null,
    })),
    updatedAt: budget?.updatedAt ?? project.createdAt,
  };
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
    // Band B (ADR-0011): a draft build has not chosen a model yet (null); a
    // legacy active project predates the concept and stays null too.
    operatingModel: project.operatingModel ?? null,
    status: project.status,
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
