// Member management (PRD-12 N-9; doc 16 §2, §8; D-34 as amended by D-38) —
// one function per operationId: inviteMember, updateMemberRole, removeMember.
//
// Clerk is the system of record for membership: every command goes to Clerk
// through the identity module's Clerk gateway port FIRST, then the mirror is
// written at once (the webhook converges on the same row). Under D-38 the
// free tier only knows `org:admin` / `org:member`, so a finer catalogue role
// rides on `public_metadata.org_role` (invitation → membership), exactly the
// override the webhook mirror honours (domain/mirror.mjs).
//
// Authorization: org:members:manage ∧ own organisation ∧ (invite) the `seats`
// entitlement through billing's port ∧ human-only (x-human-only, doc 19).
// The last admin of an organisation can be neither demoted nor removed.
import { ProblemError } from '../../../platform/errors.mjs';
import { ROLES, kindAllowsRole } from '../domain/access.mjs';
import { normalizeEmail } from '../domain/email.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Clerk's free-tier membership role for a catalogue role (D-38). */
export function clerkRoleFor(role) {
  return role === 'admin' ? 'org:admin' : 'org:member';
}

/** operationId: inviteMember — Clerk organisation invitation with the catalogue role. */
export async function inviteMember({ viewer, store, clerk, entitlements, orgId, body, idempotencyKey }) {
  const org = await authorize({ viewer, store, orgId });
  const errors = {};
  const email = normalizeEmail(body?.email);
  if (!email) errors.email = 'a valid e-mail address';
  const role = body?.org_role;
  if (!ROLES.includes(role)) errors.org_role = `one of ${ROLES.join(', ')}`;
  else if (!kindAllowsRole(org.kind, role)) errors.org_role = `a ${org.kind} organisation does not hand out ${role}`;
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // D-05: seats are an entitlement of the org's plan (doc 16 §10).
  const seat = await entitlements.entitled(org.id, 'seats');
  if (!seat.allowed) {
    throw new ProblemError('not_entitled', 'your plan has no free seat for another member', {
      upgrade_hint: '/settings/billing',
    });
  }

  const inviter = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!inviter) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');

  return store.idempotent(
    { key: idempotencyKey ?? null, caller: viewer.clerkUserId, operationId: 'inviteMember', body },
    async () => {
      const invitation = await clerk.createOrganizationInvitation({
        clerkOrgId: org.clerk_org_id,
        emailAddress: email,
        role: clerkRoleFor(role),
        inviterClerkUserId: viewer.clerkUserId,
        publicMetadata: role === 'admin' ? {} : { org_role: role },
      });
      return {
        status: 201,
        body: { id: invitation.id, email, org_role: role, status: 'pending' },
      };
    },
  );
}

/** operationId: updateMemberRole — Clerk role + metadata, then the mirror. */
export async function updateMemberRole({ viewer, store, clerk, orgId, personId, body }) {
  const org = await authorize({ viewer, store, orgId });
  const role = body?.org_role;
  if (!ROLES.includes(role)) {
    throw new ProblemError('validation_failed', null, { errors: { org_role: `one of ${ROLES.join(', ')}` } });
  }
  if (!kindAllowsRole(org.kind, role)) {
    throw new ProblemError('validation_failed', null, {
      errors: { org_role: `a ${org.kind} organisation does not hand out ${role}` },
    });
  }
  const member = await requireMember({ store, orgId, personId });
  if (member.org_role === role) return { status: 200, body: memberBody(member) };
  await guardLastAdmin({ store, orgId, member, leaving: role !== 'admin' });

  await clerk.updateMembership({
    clerkOrgId: org.clerk_org_id,
    clerkUserId: member.clerk_user_id,
    role: clerkRoleFor(role),
    publicMetadata: { org_role: role === 'admin' ? null : role },
  });
  await store.upsertMembership({ clerkOrgId: org.clerk_org_id, clerkUserId: member.clerk_user_id, orgRole: role });
  return { status: 200, body: memberBody({ ...member, org_role: role }) };
}

/** operationId: removeMember — Clerk membership deleted; staffing cleared with it (doc 16 §8). */
export async function removeMember({ viewer, store, clerk, orgId, personId }) {
  const org = await authorize({ viewer, store, orgId });
  const member = await requireMember({ store, orgId, personId });
  await guardLastAdmin({ store, orgId, member, leaving: true });
  await clerk.deleteMembership({ clerkOrgId: org.clerk_org_id, clerkUserId: member.clerk_user_id });
  await store.removeMembership({ clerkOrgId: org.clerk_org_id, clerkUserId: member.clerk_user_id });
  return { status: 204, body: null };
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function authorize({ viewer, store, orgId }) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
  if (viewer.channel === 'mcp') {
    throw new ProblemError('forbidden', 'managing members is human-only', { reason: 'human_only' });
  }
  if (!viewer.has('org:members:manage')) throw new ProblemError('forbidden', null, { reason: 'role' });
  if (orgId !== viewer.orgId) {
    throw new ProblemError('forbidden', 'you can only manage your own organisation', { reason: 'role' });
  }
  const org = await store.getOrg(orgId);
  if (!org) throw new ProblemError('not_found');
  return org;
}

async function requireMember({ store, orgId, personId }) {
  if (!UUID.test(personId ?? '')) throw new ProblemError('not_found');
  const member = await store.getMember(orgId, personId);
  if (!member) throw new ProblemError('not_found', 'not an active member of your organisation');
  return member;
}

async function guardLastAdmin({ store, orgId, member, leaving }) {
  if (member.org_role !== 'admin' || !leaving) return;
  if ((await store.countAdmins(orgId)) <= 1) {
    throw new ProblemError('invalid_transition', 'an organisation keeps at least one admin — make someone else admin first');
  }
}

export function memberBody(m) {
  return {
    id: m.id, email: m.email, name: m.name, phone: m.phone ?? undefined, locale: m.locale, org_role: m.org_role,
  };
}
