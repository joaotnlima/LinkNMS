// Participants and invitations (PRD-09 O-3..O-5; to-be/17 "joins the build by").
// One function per operationId: listParticipants, listProjectInvitations,
// inviteToProject (the PartyInvite), previewProjectInvitation,
// acceptProjectInvitation.
//
// An invitation is presence on the build WITHOUT a priced contract: the invited
// organisation joins with participation source `invitation` and reads the
// build; edit scope only ever comes from a contract (D-33, D-35). The capacity
// `contractor` (0025) is a general or specialty contractor invited before any
// contract — `specialty_code` names its trade, none = general contractor.
//
// The trade's label comes from the directory's published specialty port
// (`specialties`, injected at the composition root); project never reads
// directory.*.
import { randomUUID, randomBytes } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import {
  requireActiveOrg, requireActor, requireParticipant, actorOf, clampLimit, sha256,
} from './use-cases.mjs';

export const INVITE_CAPACITIES = Object.freeze(['contractor', 'design', 'inspection', 'safety', 'other']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SPECIALTY_CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const INVITE_DAYS = 14;

/** operationId: listParticipants — organisations, capacity, trade, staffed people (O-3). */
export async function listParticipants({ viewer, store, specialties, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const { items, nextCursor } = await store.listParticipants(projectId, {
    cursor: query?.cursor ?? null, limit: clampLimit(query?.limit),
  });
  const people = await store.listStaffedPeople(projectId, [...new Set(items.map((r) => r.org_id))]);
  const labels = await labelsOf(specialties, items.map((r) => r.specialty_code));
  return {
    status: 200,
    body: {
      items: items.map((r) => participantBody(r, {
        people: people.filter((p) => p.org_id === r.org_id).map((p) => ({ person_id: p.person_id, name: p.name })),
        specialtyName: labels.get(r.specialty_code),
      })),
      next_cursor: nextCursor,
    },
  };
}

/** operationId: listProjectInvitations — what MY organisation sent, with its state (O-3). */
export async function listProjectInvitations({ viewer, store, specialties, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const { items, nextCursor } = await store.listInvitationsSentBy(projectId, viewer.orgId, {
    cursor: query?.cursor ?? null, limit: clampLimit(query?.limit),
  });
  const labels = await labelsOf(specialties, items.map((i) => i.specialty_code));
  return {
    status: 200,
    body: { items: items.map((i) => invitationBody(i, labels.get(i.specialty_code))), next_cursor: nextCursor },
  };
}

/**
 * operationId: inviteToProject — the PartyInvite (O-4): name, email, role
 * (capacity + trade) and a scope note. The owner or the prime contractor.
 */
export async function inviteToProject({ viewer, store, specialties, projectId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:projects:staff')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const project = await store.getProject(projectId);
  if (!project) throw new ProblemError('not_found');
  const isOwner = project.owner_org_id === viewer.orgId;
  const isPrime = await store.isPrimeSupplier(projectId, viewer.orgId);
  if (!isOwner && !isPrime) throw new ProblemError('forbidden', 'only the owner or the prime contractor invites', { reason: 'relationship' });

  const errors = {};
  const email = body?.email?.trim().toLowerCase();
  if (!email || !EMAIL.test(email)) errors.email = 'valid email required';
  if (!INVITE_CAPACITIES.includes(body?.capacity)) errors.capacity = INVITE_CAPACITIES.join(', ');
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length > 200) errors.name = 'at most 200 characters';
  const scopeNote = typeof body?.scope_note === 'string' ? body.scope_note.trim() : '';
  if (scopeNote.length > 1000) errors.scope_note = 'at most 1000 characters';
  const code = body?.specialty_code ?? null;
  if (code != null) {
    if (typeof code !== 'string' || !SPECIALTY_CODE.test(code) || code.length > 60) errors.specialty_code = 'a code from GET /specialties';
    else if (!specialties || !(await specialties.exists(code))) errors.specialty_code = `unknown specialty code: ${code}`;
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = await requireActor(store, viewer);
  const token = randomBytes(24).toString('hex');
  const invitation = await store.createInvitation({
    id: randomUUID(),
    projectId,
    invitedByOrgId: viewer.orgId,
    email,
    capacity: body.capacity,
    specialtyCode: code,
    inviteeName: name || null,
    scopeNote: scopeNote || null,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 3600 * 1000).toISOString(),
    actor: actorOf(actor, viewer),
  });
  const labels = await labelsOf(specialties, [code]);
  // `token` is returned ONCE, to the inviter (contract note in openapi.yaml);
  // only its hash is stored. The inviter forwards the accept link.
  return { status: 201, body: { ...invitationBody(invitation, labels.get(code)), token } };
}

/**
 * operationId: previewProjectInvitation — the ONE unauthenticated read besides
 * the RFP personal link (LINA-398): the token in the path IS the credential.
 * ANTI-ORACLE: unknown, spent, revoked and expired tokens all answer the
 * identical 404. O-5: it names the real role — the capacity AND the trade.
 */
export async function previewProjectInvitation({ store, specialties, token }) {
  const inv = await store.getInvitationPreviewByTokenHash(sha256(token ?? ''));
  if (!inv || inv.status !== 'pending') throw new ProblemError('not_found');
  if (new Date(inv.expires_at).getTime() < Date.now()) throw new ProblemError('not_found');
  const labels = await labelsOf(specialties, [inv.specialty_code]);
  return {
    status: 200,
    body: {
      project_name: inv.project_name ?? null,
      invited_by_name: inv.invited_by_name ?? null,
      capacity: inv.capacity,
      ...(inv.specialty_code ? { specialty_code: inv.specialty_code } : {}),
      ...(labels.get(inv.specialty_code) ? { specialty_name: labels.get(inv.specialty_code) } : {}),
      ...(inv.invitee_name ? { invitee_name: inv.invitee_name } : {}),
      ...(inv.scope_note ? { scope_note: inv.scope_note } : {}),
    },
  };
}

/** operationId: acceptProjectInvitation — with my active org; the trade travels to the participation. */
export async function acceptProjectInvitation({ viewer, store, specialties, token }) {
  requireActiveOrg(viewer);
  const actor = await requireActor(store, viewer);
  const invitation = await store.getInvitationByTokenHash(sha256(token ?? ''));
  if (!invitation || invitation.status === 'revoked') throw new ProblemError('not_found');
  if (invitation.status === 'accepted') throw new ProblemError('invalid_transition', 'already accepted');
  if (new Date(invitation.expires_at).getTime() < Date.now()) throw new ProblemError('gone', 'invitation expired');

  const participant = await store.acceptInvitation({
    invitationId: invitation.id,
    projectId: invitation.project_id,
    orgId: viewer.orgId,
    inviteCapacity: invitation.capacity,
    specialtyCode: invitation.specialty_code ?? null,
    actor: actorOf(actor, viewer),
  });
  const labels = await labelsOf(specialties, [participant.specialty_code]);
  // `project_id` lets the accept deep link redirect straight to the build.
  return {
    status: 200,
    body: { ...participantBody(participant, { specialtyName: labels.get(participant.specialty_code) }), project_id: invitation.project_id },
  };
}

// ── bodies ───────────────────────────────────────────────────────────────

/** code → EN label through the directory port; an unavailable port names nothing. */
async function labelsOf(specialties, codes) {
  const out = new Map();
  const wanted = [...new Set(codes.filter(Boolean))];
  if (!wanted.length || !specialties?.describe) return out;
  for (const code of wanted) {
    try {
      const d = await specialties.describe(code);
      if (d) out.set(code, d.name_en ?? d.name_pt ?? code);
    } catch { /* the label is decoration: the code still answers */ }
  }
  return out;
}

export function participantBody(row, { people, specialtyName } = {}) {
  return {
    org: {
      id: row.org_id,
      kind: row.org_kind,
      legal_name: row.legal_name,
      nif: row.nif ?? undefined,
    },
    capacity: row.capacity,
    source: row.source,
    contract_id: row.contract_id ?? undefined,
    invite_capacity: row.invite_capacity ?? undefined,
    specialty_code: row.specialty_code ?? undefined,
    specialty_name: specialtyName ?? undefined,
    ...(people ? { people } : {}),
  };
}

function invitationBody(i, specialtyName) {
  const expired = i.status === 'pending' && new Date(i.expires_at).getTime() < Date.now();
  return {
    id: i.id,
    project_id: i.project_id,
    email: i.email,
    name: i.invitee_name ?? undefined,
    capacity: i.capacity,
    specialty_code: i.specialty_code ?? undefined,
    specialty_name: specialtyName ?? undefined,
    scope_note: i.scope_note ?? undefined,
    created_at: i.created_at?.toISOString?.() ?? i.created_at ?? undefined,
    status: expired ? 'expired' : i.status,
    expires_at: i.expires_at?.toISOString?.() ?? i.expires_at,
  };
}
