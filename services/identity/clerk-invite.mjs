// Identity — Clerk org-invitation mechanism for waitlist activation (LINA-130;
// Onboarding Plan v4 Phase 2, D-1).
//
// On the go-date the owner runs the batch (scripts/send-waitlist-invitations.mjs)
// to activate the first 10 waitlisted users (ordered by signup_order). Activation
// IS the D-1 email: a Clerk org invitation carrying the CTA link the invitee
// clicks to complete auth and join the portal.
//
// This module is the pure, injectable heart of that batch, mirroring
// services/auth/clerk.mjs's seam discipline: the real Clerk SDK never appears at
// the top of this file. `createClerkOrgInviter` constructs the SDK-backed
// inviter, but the orchestration `sendWaitlistInvitations` takes an injected
// `inviter` port so the tricky logic — "first N by signup_order", "only waitlisted
// rows", "flip to active", "grant a seat", "one failed invite must not lose the
// other nine" — is provable in zero-dep tests.
//
// WHY A SEAT, NOT JUST AN INVITATION (ADR-0008): the D-1 invitation letters
// people INTO Clerk, but the front door is still guarded by identity.seat —
// app/src/server/session.ts turns a Clerk identity into a party only for a
// verified address holding an active seat; an unseated user authenticates and is
// shown /no-access. So an invitation alone does not activate anybody. The batch
// therefore grants each invited address a beta seat in the same run (source
// 'beta', the ten-seat giveaway), the exact SQL grant-seat.mjs uses, so the
// invitee can actually complete activation when they click through.
//
// AUDITABILITY (the platform's reason to exist): nothing here is silent. Each
// row's outcome is returned with its Clerk invitation id, the flips applied, and
// a per-email status string. The waitlist_activation migration records the Clerk
// invitation id against the signup so "who was activated, when, by which
// invitation" is a lookup, not a guess.

const defaultClock = () => new Date().toISOString();

/**
 * The inviter PORT. Returns the Clerk invitation id for an address, or throws.
 * @typedef {(email: string) => Promise<string>} Inviter
 */

/**
 * Build the real Clerk org-invitation port from @clerk/backend. Optional
 * dependency — loaded lazily so this module's pure paths run zero-dep in tests.
 *
 * Invites a single email to `orgId` with Clerk org role `role` and returns the
 * Clerk invitation id. Throws on any failure (the batch decides how to degrade).
 * @param {{ secretKey: string, orgId: string, role?: string }} deps
 * @param {Object} [clerkBackend]  the `@clerk/backend` module (default: imported)
 * @returns {Inviter}
 */
export function createClerkOrgInviter({ secretKey, orgId, role = 'basic_member' }, clerkBackend) {
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is required to send Clerk org invitations');
  if (!orgId) throw new Error('CLERK_ORG_ID is required to send Clerk org invitations');
  if (!clerkBackend) {
    // eslint-disable-next-line global-require
    throw new Error('@clerk/backend is required to send Clerk org invitations (install it in services/)');
  }
  const client = clerkBackend.createClerkClient({ secretKey });
  return async function invite(email) {
    const invitation = await client.organizations.createOrganizationInvitation({
      organizationId: orgId,
      emailAddress: email,
      role,
    });
    return invitation.id;
  };
}

/**
 * Activate the first `limit` WAITLISTED signups, ordered by signup_order, by:
 *   1. sending each a Clerk org invitation (via the injected `inviter`);
 *   2. granting each an active beta seat (identity.seat, ADR-0008) and flipping
 *      the waitlist row to `active` with `activated_at` — only when the invite
 *      succeeded, so a row is never marked active before it was offered access;
 *   3. recording the Clerk invitation id for audit.
 *
 * Partial failure is contained: one address whose invite throws does NOT abort
 * the batch — it is reported `failed` and the rest proceed. Nothing rolls over an
 * already-invited row: `listByStatusOrder('waitlisted')` only returns rows still
 * `waitlisted`, so a re-run naturally skips already-activated ones.
 *
 * `dryRun` performs the SELECT and bookkeeping but never invites, seats, or
 * flips — used to preview who WOULD go out before the owner commits.
 *
 * Store port surface used: listByStatusOrder(status, limit), promoteToActive(email),
 * recordActivation(email, invitationId). Seats port used: grant(email, {source}).
 *
 * @param {Object} deps
 * @param {Object} deps.store     Waitlist store (listByStatusOrder / promoteToActive / recordActivation)
 * @param {Object} deps.seats     Seat port (grant)
 * @param {Inviter} deps.inviter  async (email) => invitationId
 * @param {number} [deps.limit=10]
 * @param {boolean} [deps.dryRun=false]
 * @param {Function} [deps.clock]
 * @returns {Promise<{ invited: Array<Object>, summary: { total: number, invited: number, failed: number, dryRun: boolean } }>}
 */
export async function sendWaitlistInvitations({
  store,
  seats,
  inviter,
  limit = 10,
  dryRun = false,
  clock = defaultClock,
}) {
  if (!store || !seats || !inviter) {
    throw new Error('sendWaitlistInvitations requires { store, seats, inviter } ports');
  }
  void clock;

  // "The first 10 waitlisted, by signup_order" — a deterministic total order (the
  // identity counter, not a timestamp two rows could share). Only rows still
  // `waitlisted` are candidates, so a rerun never double-invites.
  const candidates = await store.listByStatusOrder('waitlisted', limit);

  const invited = [];
  let invitedCount = 0;
  let failedCount = 0;

  for (const row of candidates) {
    const email = row.email;
    const entry = { email, signupOrder: row.signup_order, outcome: 'dryrun', clerkInvitationId: null, error: null };

    if (!dryRun) {
      try {
        const invitationId = await inviter(email);
        await store.promoteToActive(email);
        await store.recordActivation(email, invitationId);
        await seats.grant(email, { source: 'beta' });
        entry.outcome = 'invited';
        entry.clerkInvitationId = invitationId;
        invitedCount += 1;
      } catch (err) {
        entry.outcome = 'failed';
        entry.error = (err && err.message) || String(err);
        failedCount += 1;
      }
    }

    invited.push(entry);
  }

  return {
    invited,
    summary: { total: candidates.length, invited: invitedCount, failed: failedCount, dryRun },
  };
}
