// Identity & Access use cases (phase 1) — one function per operationId.
//
// Authorization here is exactly the doc-16 conjunction, in order:
//   permission (viewer.has, token-only) ∧ relationship (project.participation)
//   ∧ staffing — entitlement (billing) has no port yet, phase 8.
// The store owns transactions AND writes the ledger entry inside them
// (invariant §6.4); a use case never half-commits.
import { ProblemError } from '../../../platform/errors.mjs';
import { commandFor } from '../domain/mirror.mjs';
import { verifySvix } from '../infra/svix.mjs';

const CREATABLE_KINDS = new Set(['household', 'contractor', 'consultant']);

/** operationId: getMe */
export async function getMe({ viewer, store }) {
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) {
    // Sign-up webhook has not landed yet; the UI retries.
    throw new ProblemError('not_found', 'your identity mirror has not caught up yet — retry in a moment');
  }
  const organizations = await store.listOrgsForPerson(person.id);
  const active = viewer.clerkOrgId
    ? organizations.find((m) => m.org.clerk_org_id === viewer.clerkOrgId) ?? null
    : null;
  return {
    status: 200,
    body: {
      person: personBody(person),
      active_org: active ? orgBody(active.org) : null,
      org_role: active ? viewer.orgRole : null,
      permissions: active ? viewer.permissionList() : [],
      organizations: organizations.map((m) => ({ org: orgBody(m.org), org_role: m.org_role })),
      // project.project_invitation is phase-2 surface; until the project
      // module lands, there is nothing that could have invited this person.
      pending_project_invitations: [],
    },
  };
}

/** operationId: createOrganization */
export async function createOrganization({ viewer, store, clerk, body, idempotencyKey }) {
  const errors = {};
  if (!CREATABLE_KINDS.has(body?.kind)) errors.kind = 'must be household, contractor or consultant';
  if (!body?.legal_name?.trim()) errors.legal_name = 'required';
  if (body?.approval_policy && !['any', 'all'].includes(body.approval_policy)) errors.approval_policy = 'any or all';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const creator = await requirePerson(store, viewer);

  return store.idempotent({ key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'createOrganization', body }, async () => {
    // Clerk owns organisations (doc 16 §2): create there first, with the kind
    // in public_metadata so the webhook mirror agrees with what we write now.
    const clerkOrg = await clerk.createOrganization({
      name: body.legal_name.trim(),
      createdBy: viewer.clerkUserId,
      publicMetadata: {
        kind: body.kind,
        nif: body.nif ?? null,
        approval_policy: body.approval_policy ?? 'any',
      },
    });
    const org = await store.upsertOrganization({
      clerkOrgId: clerkOrg.clerkOrgId,
      orgKind: body.kind,
      legalName: body.legal_name.trim(),
      nif: body.nif ?? null,
      approvalPolicy: body.approval_policy ?? 'any',
    });
    // Clerk adds the creator as org:admin; mirror that without waiting.
    await store.upsertMembership({ clerkOrgId: clerkOrg.clerkOrgId, clerkUserId: creator.clerk_user_id, orgRole: 'admin' });
    return { status: 201, body: orgBody(org) };
  });
}

/** operationId: listMembers */
export async function listMembers({ viewer, store, orgId, query }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:members:manage')) throw new ProblemError('forbidden', null, { reason: 'role' });
  if (orgId !== viewer.orgId) {
    // Memberships of another company are not yours to read, whatever the role.
    throw new ProblemError('forbidden', 'you can only list your own organisation', { reason: 'role' });
  }
  const limit = clampLimit(query?.limit);
  const { items, nextCursor } = await store.listMembers(orgId, { cursor: query?.cursor ?? null, limit });
  return {
    status: 200,
    body: { items: items.map((m) => ({ ...personBody(m), org_role: m.org_role })), next_cursor: nextCursor },
  };
}

/** operationId: staffPerson */
export async function staffPerson({ viewer, store, projectId, personId }) {
  const { actor } = await authorizeStaffing({ viewer, store, projectId, personId });
  const staffing = await store.staff({
    projectId,
    orgId: viewer.orgId,
    personId,
    staffedBy: actor.id,
    actor: { personId: actor.id, orgId: viewer.orgId, orgRole: viewer.orgRole },
  });
  return { status: 200, body: { project_id: staffing.project_id, org_id: staffing.org_id, person_id: staffing.person_id } };
}

/** operationId: unstaffPerson */
export async function unstaffPerson({ viewer, store, projectId, personId }) {
  const { actor } = await authorizeStaffing({ viewer, store, projectId, personId });
  const removed = await store.unstaff({
    projectId,
    orgId: viewer.orgId,
    personId,
    actor: { personId: actor.id, orgId: viewer.orgId, orgRole: viewer.orgRole },
  });
  if (!removed) throw new ProblemError('not_found', 'this person is not staffed on the project');
  return { status: 204, body: null };
}

async function authorizeStaffing({ viewer, store, projectId, personId }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:projects:staff')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const actor = await requirePerson(store, viewer);
  const membership = await store.getActiveMembership(viewer.orgId, personId);
  if (!membership) throw new ProblemError('not_found', 'not an active member of your organisation');
  if (!(await store.isProjectParticipant(projectId, viewer.orgId))) {
    throw new ProblemError('not_a_participant');
  }
  return { actor };
}

/** operationId: clerkWebhook — machine caller, svix-authenticated. */
export async function clerkWebhook({ store, headers, rawBody, secret }) {
  const verdict = verifySvix({ secret, headers, rawBody });
  if (!verdict.ok) throw new ProblemError('unauthenticated', `svix: ${verdict.reason}`);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new ProblemError('validation_failed', 'webhook body is not JSON');
  }

  const cmd = commandFor(event);
  switch (cmd.kind) {
    case 'upsert_person':
      await store.upsertPerson(cmd);
      break;
    case 'upsert_organization':
      await store.upsertOrganization(cmd);
      break;
    case 'upsert_membership':
    case 'remove_membership': {
      // Membership webhooks can outrun user./organization. ones; answering
      // 409 makes Svix redeliver after the mirror rows exist.
      const ready = await store.mirrorReady(cmd.clerkOrgId, cmd.clerkUserId);
      if (!ready) throw new ProblemError('version_conflict', 'mirror rows not there yet — redeliver');
      if (cmd.kind === 'upsert_membership') await store.upsertMembership(cmd);
      else await store.removeMembership(cmd); // also clears project staffing (doc 16 §8)
      break;
    }
    case 'guard_org_delete': {
      const org = await store.getOrgByClerkId(cmd.clerkOrgId);
      if (org && (await store.orgHasSignedContracts(org.id))) {
        // Doc 16 §8: the record cannot lose a party. The mirror row stays and
        // the failure is loud on the Svix dashboard.
        throw new ProblemError('invalid_transition', 'organisation is party to a signed contract; close contracts first');
      }
      // No signed contracts: keep the row anyway — attribution outlives orgs.
      break;
    }
    case 'reject':
      throw new ProblemError('validation_failed', cmd.reason);
    case 'ignore':
      break;
    default:
      throw new Error(`unhandled mirror command ${cmd.kind}`);
  }
  return { status: 204, body: null };
}

async function requirePerson(store, viewer) {
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
  return person;
}

function requireActiveOrg(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function personBody(p) {
  return { id: p.id, email: p.email, name: p.name, phone: p.phone ?? undefined, locale: p.locale };
}

function orgBody(o) {
  return { id: o.id, kind: o.kind, legal_name: o.legal_name, nif: o.nif ?? undefined, approval_policy: o.approval_policy };
}
