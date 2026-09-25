// Project module use cases (phase 2) — one function per operationId.
//
// Authorization is the doc-16 conjunction, in order:
//   permission (viewer.has, token-only) ∧ relationship ∧ staffing.
// Relationships here (openapi x-relationship):
//   project.participant — a participation row for the viewer's org, or the
//     org is the owner, or it CREATED the project (the draft-driver keeps
//     visibility of an unclaimed draft — doc 14 Q4);
//   project.owner — owner_org_id is the viewer's org; while a supplier-created
//     draft is unclaimed, the CREATOR drives the brief (locations, edits) —
//     ownership transfers on claim;
//   prime supplier — supplier of a signed prime contract (calendar, invites).
// Staffing (doc 16 §4): admins and managers see every project of their org;
// everyone else only projects they are staffed on.
// Entitlement (billing, 402) has no port yet — phase 8.
//
// The store owns transactions AND writes the ledger entry inside them
// (invariant §6.4); a use case never half-commits.
import { randomUUID, randomBytes, createHash } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import { transition, briefComplete, operatingModel } from '../domain/lifecycle.mjs';

const LOCATION_KINDS = new Set(['site', 'building', 'unit', 'floor', 'zone']);
const INVITE_CAPACITIES = new Set(['design', 'inspection', 'safety', 'other']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Project ──────────────────────────────────────────────────────────────

/** operationId: createProject */
export async function createProject({ viewer, store, body, idempotencyKey }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:projects:create')) throw new ProblemError('forbidden', null, { reason: 'role' });

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (!body?.name?.trim()) errors.name = 'required';
  if (!body?.municipality_code?.trim()) errors.municipality_code = 'required';
  const onBehalf = body?.on_behalf_of_owner_email?.trim().toLowerCase() ?? null;
  if (onBehalf && !EMAIL.test(onBehalf)) errors.on_behalf_of_owner_email = 'not an email';
  if (body?.indicative_budget && !Number.isInteger(body.indicative_budget.amount_cents)) {
    errors.indicative_budget = 'amount_cents must be integer cents';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = await requireActor(store, viewer);
  return store.idempotent({ key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'createProject', body }, async () => {
    const project = await store.createProject({
      id: body.id,
      name: body.name.trim(),
      address: body.address ?? null,
      municipalityCode: body.municipality_code.trim(),
      typology: body.typology ?? null,
      grossAreaM2: body.gross_area_m2 ?? null,
      indicativeBudgetCents: body.indicative_budget?.amount_cents ?? null,
      // Doc 14 Q4: created for an owner → unowned draft until claimed.
      ownerOrgId: onBehalf ? null : viewer.orgId,
      pendingOwnerEmail: onBehalf,
      createdByOrgId: viewer.orgId,
      actor: actorOf(actor, viewer),
    });
    return { status: 201, body: projectBody(project, 'undetermined') };
  });
}

/** operationId: listProjects */
export async function listProjects({ viewer, store, query }) {
  requireActiveOrg(viewer);
  const actor = await requireActor(store, viewer);
  const { items, nextCursor } = await store.listProjectsForOrg({
    orgId: viewer.orgId,
    personId: seesWholeOrg(viewer) ? null : actor.id, // staffing gate (doc 16 §4)
    status: query?.status ?? null,
    capacity: query?.capacity ?? null,
    cursor: query?.cursor ?? null,
    limit: clampLimit(query?.limit),
  });
  return {
    status: 200,
    body: { items: items.map((p) => overviewBody(p, p.operating_model)), next_cursor: nextCursor },
  };
}

/** operationId: getProject */
export async function getProject({ viewer, store, projectId }) {
  const { project } = await requireParticipant({ viewer, store, projectId });
  return { status: 200, body: projectBody(project, await store.getOperatingModel(projectId)) };
}

/** operationId: updateProject */
export async function updateProject({ viewer, store, projectId, body, ifMatch }) {
  const { project } = await requireBriefDriver({ viewer, store, projectId, permission: 'org:plan:edit' });
  const expected = parseIfMatch(ifMatch);
  if (expected !== project.version) {
    throw new ProblemError('version_conflict', `project is at version ${project.version}`);
  }
  if (['closed', 'cancelled'].includes(project.status)) {
    throw new ProblemError('invalid_transition', `cannot edit a ${project.status} project`);
  }

  const errors = {};
  if (body?.name !== undefined && !body.name?.trim()) errors.name = 'must not be blank';
  if (body?.municipality_code !== undefined && !body.municipality_code?.trim()) errors.municipality_code = 'must not be blank';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = await requireActor(store, viewer);
  const updated = await store.updateProjectBrief({
    projectId,
    expectedVersion: expected,
    patch: {
      name: body?.name?.trim(),
      address: body?.address,
      municipalityCode: body?.municipality_code?.trim(),
      typology: body?.typology,
      grossAreaM2: body?.gross_area_m2,
      indicativeBudgetCents: body?.indicative_budget === null ? null : body?.indicative_budget?.amount_cents,
    },
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('version_conflict', 'someone changed the brief first');
  return { status: 200, body: projectBody(updated, await store.getOperatingModel(projectId)) };
}

/** operationId: claimProject — the invited owner takes ownership (doc 14 Q4). */
export async function claimProject({ viewer, store, projectId }) {
  requireActiveOrg(viewer);
  const actor = await requireActor(store, viewer);
  const project = await store.getProject(projectId);
  if (!project) throw new ProblemError('not_found');
  if (project.owner_org_id) throw new ProblemError('invalid_transition', 'this project already has an owner');
  if (!project.pending_owner_email || project.pending_owner_email !== actor.email.toLowerCase()) {
    // Not the invited owner: the project's existence is not theirs to learn.
    throw new ProblemError('not_found');
  }
  const claimed = await store.claimProject({ projectId, ownerOrgId: viewer.orgId, actor: actorOf(actor, viewer) });
  return { status: 200, body: projectBody(claimed, 'undetermined') };
}

/** operationId: cancelProject */
export async function cancelProject({ viewer, store, projectId }) {
  const { project } = await requireBriefDriver({ viewer, store, projectId, permission: 'org:projects:create' });
  const noSignedContract = !(await store.hasSignedContracts(projectId));
  const verdict = transition(project.status, 'cancel', { noSignedContract });
  if (!verdict.ok) throw new ProblemError('invalid_transition', verdict.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.setStatus({ projectId, from: project.status, to: verdict.to, action: 'cancel', actor: actorOf(actor, viewer) });
  return { status: 200, body: projectBody(updated, await store.getOperatingModel(projectId)) };
}

/** operationId: closeProject */
export async function closeProject({ viewer, store, projectId }) {
  const { project } = await requireOwner({ viewer, store, projectId });
  const allOwnerContractsSettled = (await store.countOpenOwnerContracts(projectId)) === 0;
  const verdict = transition(project.status, 'close', { allOwnerContractsSettled });
  if (!verdict.ok) throw new ProblemError('invalid_transition', verdict.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.setStatus({ projectId, from: project.status, to: verdict.to, action: 'close', actor: actorOf(actor, viewer) });
  return { status: 200, body: projectBody(updated, await store.getOperatingModel(projectId)) };
}

/** operationId: getProjectOverview */
export async function getProjectOverview({ viewer, store, projectId }) {
  const { project } = await requireParticipant({ viewer, store, projectId });
  return {
    status: 200,
    body: overviewBody({ ...project, open_variations: 0, open_questions: 0, pending_verifications: 0 },
      await store.getOperatingModel(projectId)),
  };
}

// ── Locations ────────────────────────────────────────────────────────────

/** operationId: listLocations */
export async function listLocations({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const { items, nextCursor } = await store.listLocations(projectId, {
    cursor: query?.cursor ?? null, limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(locationBody), next_cursor: nextCursor } };
}

/** operationId: createLocation */
export async function createLocation({ viewer, store, projectId, body }) {
  await requireBriefDriver({ viewer, store, projectId, permission: 'org:plan:edit' });
  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (!LOCATION_KINDS.has(body?.kind)) errors.kind = 'site, building, unit, floor or zone';
  if (!body?.name?.trim()) errors.name = 'required';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  if (body.parent_id) {
    const parent = await store.getLocation(body.parent_id);
    if (!parent || parent.project_id !== projectId) {
      throw new ProblemError('validation_failed', null, { errors: { parent_id: 'not a location of this project' } });
    }
  }
  const actor = await requireActor(store, viewer);
  const location = await store.createLocation({
    id: body.id, projectId, parentId: body.parent_id ?? null,
    kind: body.kind, name: body.name.trim(), position: body.position ?? '',
    actor: actorOf(actor, viewer),
  });
  return { status: 201, body: locationBody(location) };
}

/** operationId: updateLocation */
export async function updateLocation({ viewer, store, locationId, body }) {
  const location = await store.getLocation(locationId);
  if (!location) throw new ProblemError('not_found');
  await requireBriefDriver({ viewer, store, projectId: location.project_id, permission: 'org:plan:edit' });
  const errors = {};
  if (body?.kind !== undefined && !LOCATION_KINDS.has(body.kind)) errors.kind = 'site, building, unit, floor or zone';
  if (body?.name !== undefined && !body.name?.trim()) errors.name = 'must not be blank';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  const actor = await requireActor(store, viewer);
  const updated = await store.updateLocation({
    locationId,
    patch: { kind: body?.kind, name: body?.name?.trim(), position: body?.position },
    actor: actorOf(actor, viewer),
  });
  return { status: 200, body: locationBody(updated) };
}

/** operationId: deleteLocation — only an UNUSED location may go. */
export async function deleteLocation({ viewer, store, locationId }) {
  const location = await store.getLocation(locationId);
  if (!location) throw new ProblemError('not_found');
  await requireBriefDriver({ viewer, store, projectId: location.project_id, permission: 'org:plan:edit' });
  if (await store.locationInUse(locationId)) {
    throw new ProblemError('invalid_transition', 'location has children or tasks scoped to it');
  }
  const actor = await requireActor(store, viewer);
  await store.deleteLocation({ locationId, projectId: location.project_id, actor: actorOf(actor, viewer) });
  return { status: 204, body: null };
}

// ── Participants & invitations ───────────────────────────────────────────

/** operationId: listParticipants */
export async function listParticipants({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const { items, nextCursor } = await store.listParticipants(projectId, {
    cursor: query?.cursor ?? null, limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(participantBody), next_cursor: nextCursor } };
}

/** operationId: inviteToProject — consultant / inspector / HSE, no priced contract. */
export async function inviteToProject({ viewer, store, projectId, body }) {
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
  if (!INVITE_CAPACITIES.has(body?.capacity)) errors.capacity = 'design, inspection, safety or other';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = await requireActor(store, viewer);
  const token = randomBytes(24).toString('hex');
  const invitation = await store.createInvitation({
    id: randomUUID(),
    projectId,
    invitedByOrgId: viewer.orgId,
    email,
    capacity: body.capacity,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    actor: actorOf(actor, viewer),
  });
  // `token` is returned ONCE, to the inviter (contract note in openapi.yaml);
  // only its hash is stored. Delivery by email is the notifications module.
  return { status: 201, body: { ...invitationBody(invitation), token } };
}

/** operationId: acceptProjectInvitation */
export async function acceptProjectInvitation({ viewer, store, token }) {
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
    actor: actorOf(actor, viewer),
  });
  return { status: 200, body: participantBody(participant) };
}

// ── Calendar & share links ───────────────────────────────────────────────

/** operationId: getCalendar */
export async function getCalendar({ viewer, store, projectId }) {
  const { project } = await requireParticipant({ viewer, store, projectId });
  const calendar = await store.getCalendar(projectId);
  const holidays = await store.listHolidays(project.municipality_code);
  return {
    status: 200,
    body: {
      work_days: calendar?.work_days ?? [1, 2, 3, 4, 5],
      closures: (calendar?.closures ?? []).map(({ from, to }) => ({ from, to })),
      holidays: holidays.map((h) => ({ date: h.date, name: h.name })),
    },
  };
}

/** operationId: putCalendar */
export async function putCalendar({ viewer, store, projectId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:plan:edit')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const project = await store.getProject(projectId);
  if (!project) throw new ProblemError('not_found');
  const isOwner = project.owner_org_id === viewer.orgId;
  if (!isOwner && !(await store.isPrimeSupplier(projectId, viewer.orgId))) {
    throw new ProblemError('forbidden', 'only the owner or the prime contractor edits the calendar', { reason: 'relationship' });
  }

  const errors = {};
  const workDays = body?.work_days;
  if (!Array.isArray(workDays) || workDays.length === 0
      || workDays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    errors.work_days = 'a non-empty list of ISO weekdays 1..7';
  }
  const closures = body?.closures ?? [];
  if (!Array.isArray(closures) || closures.some((c) => !c?.from || !c?.to || c.from > c.to)) {
    errors.closures = 'each closure needs from <= to (ISO dates)';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = await requireActor(store, viewer);
  const saved = await store.putCalendar({
    projectId,
    workDays: [...new Set(workDays)].sort(),
    closures: closures.map(({ from, to }) => ({ from, to })),
    actor: actorOf(actor, viewer),
  });
  const holidays = await store.listHolidays(project.municipality_code);
  return {
    status: 200,
    body: {
      work_days: saved.work_days,
      closures: saved.closures.map(({ from, to }) => ({ from, to })),
      holidays: holidays.map((h) => ({ date: h.date, name: h.name })),
    },
  };
}

/** operationId: createShareLink — scoped, expiring, for a licensing authority. */
export async function createShareLink({ viewer, store, projectId, body, shareBaseUrl }) {
  const { project } = await requireOwner({ viewer, store, projectId, permission: 'org:plan:edit' });
  const errors = {};
  if (!body?.audience?.trim()) errors.audience = 'required — who this link is for';
  const expiresAt = body?.expires_at ? new Date(body.expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    errors.expires_at = 'a future date-time';
  } else if (expiresAt.getTime() > Date.now() + 90 * 24 * 3600 * 1000) {
    errors.expires_at = 'at most 90 days out';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = await requireActor(store, viewer);
  const token = randomBytes(24).toString('hex');
  const link = await store.createShareLink({
    id: randomUUID(),
    projectId: project.id,
    createdByPersonId: actor.id,
    audience: body.audience.trim(),
    documentIds: body.document_ids ?? [],
    taskIds: body.task_ids ?? [],
    tokenHash: sha256(token),
    expiresAt: expiresAt.toISOString(),
    actor: actorOf(actor, viewer),
  });
  return {
    status: 201,
    body: {
      id: link.id,
      audience: link.audience,
      document_ids: link.document_ids,
      task_ids: link.task_ids,
      url: `${shareBaseUrl}/share/${token}`,
      expires_at: link.expires_at,
    },
  };
}

// ── shared authorization helpers ─────────────────────────────────────────

function requireActiveOrg(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

/** Doc 16 §4: admin/manager see all of the org's projects; others need staffing. */
function seesWholeOrg(viewer) {
  return viewer.orgRole === 'admin' || viewer.orgRole === 'manager';
}

async function requireActor(store, viewer) {
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
  return person;
}

/** relationship: project.participant (∧ staffing for non-managers). */
async function requireParticipant({ viewer, store, projectId }) {
  requireActiveOrg(viewer);
  const project = await store.getProject(projectId);
  if (!project) throw new ProblemError('not_found');
  const related = project.owner_org_id === viewer.orgId
    || project.created_by_org_id === viewer.orgId
    || (await store.isParticipant(projectId, viewer.orgId));
  // 404, not 403: a non-participant does not learn the project exists.
  if (!related) throw new ProblemError('not_found');
  if (!seesWholeOrg(viewer)) {
    const actor = await requireActor(store, viewer);
    if (!(await store.isStaffed(projectId, viewer.orgId, actor.id))) {
      throw new ProblemError('not_a_participant', 'you are not staffed on this project');
    }
  }
  return { project };
}

/** relationship: project.owner (strict — claim has happened). */
async function requireOwner({ viewer, store, projectId, permission = null }) {
  const { project } = await requireParticipant({ viewer, store, projectId });
  if (permission && !viewer.has(permission)) throw new ProblemError('forbidden', null, { reason: 'role' });
  if (project.owner_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the project owner may do this', { reason: 'relationship' });
  }
  return { project };
}

/**
 * relationship: project.owner, extended to the unclaimed case — while a
 * supplier-created draft has no owner yet, its CREATOR drives the brief.
 */
async function requireBriefDriver({ viewer, store, projectId, permission }) {
  const { project } = await requireParticipant({ viewer, store, projectId });
  if (!viewer.has(permission)) throw new ProblemError('forbidden', null, { reason: 'role' });
  const drives = project.owner_org_id
    ? project.owner_org_id === viewer.orgId
    : project.created_by_org_id === viewer.orgId;
  if (!drives) throw new ProblemError('forbidden', 'only the project owner may do this', { reason: 'relationship' });
  return { project };
}

// ── bodies & small helpers ───────────────────────────────────────────────

function actorOf(person, viewer) {
  return { personId: person.id, orgId: viewer.orgId, orgRole: viewer.orgRole, channel: viewer.channel };
}

function parseIfMatch(raw) {
  const n = Number(String(raw ?? '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 1) throw new ProblemError('validation_failed', 'If-Match must carry the project version');
  return n;
}

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function money(cents) {
  return cents == null ? undefined : { amount_cents: Number(cents), currency: 'EUR' };
}

function projectBody(p, opModel) {
  return {
    id: p.id,
    name: p.name,
    address: p.address ?? undefined,
    municipality_code: p.municipality_code,
    typology: p.typology ?? undefined,
    gross_area_m2: p.gross_area_m2 == null ? undefined : Number(p.gross_area_m2),
    indicative_budget: money(p.indicative_budget_cents),
    owner_org_id: p.owner_org_id ?? undefined,
    status: p.status,
    operating_model: opModel,
    version: p.version,
  };
}

function overviewBody(p, opModel) {
  return {
    project: projectBody(p, opModel ?? 'undetermined'),
    // end_date / cost / health are planning+contracting roll-ups (phases 4-5);
    // until those modules land the counters are honestly zero, not invented.
    open_variations: Number(p.open_variations ?? 0),
    open_questions: Number(p.open_questions ?? 0),
    pending_verifications: Number(p.pending_verifications ?? 0),
  };
}

function locationBody(l) {
  return {
    id: l.id,
    parent_id: l.parent_id ?? undefined,
    kind: l.kind,
    name: l.name,
    position: l.position ?? undefined,
  };
}

function participantBody(row) {
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
  };
}

function invitationBody(i) {
  return {
    id: i.id,
    project_id: i.project_id,
    email: i.email,
    capacity: i.capacity,
    status: i.status,
    expires_at: i.expires_at,
  };
}
