// Quality module use cases (phase 5) — one function per operationId:
//   listMyVerifications, acceptVerification, rejectVerification,
//   raiseNonConformity, assignNonConformity, fixNonConformity,
//   closeNonConformity, rejectFixNonConformity, recordInspection.
//
// Authorization is the doc-16 conjunction, in order:
//   permission (viewer.has, token-only) ∧ relationship ∧ staffing.
// Relationships (openapi x-relationship, doc 04 §verify + doc 17 §5):
//   client chain | invited inspector — verification decisions: an org whose
//     edit scope contains the row (client of the task's branch contract, up
//     the chain to the project owner) or a consultant invited with capacity
//     inspection/safety — NEVER the org whose report marked it done (D-31,
//     DB CHECK 8g backs it);
//   project.participant — raiseNonConformity;
//   raiser | client chain — assignNonConformity;
//   assignee — fixNonConformity (the org told to fix it reports the fix);
//   raising org only — close / reject-fix (DB CHECK 8h backs close);
//   invited inspector | client chain — recordInspection.
// Verification decisions and NC closure are x-human-only (doc 19): the MCP
// channel is answered forbidden{reason:'human_only'} before anything else.
//
// The store owns transactions AND writes ledger + outbox inside them
// (invariants §6.3/§6.4); a use case never half-commits.
import { ProblemError } from '../../../platform/errors.mjs';
import {
  verificationTransition, nonConformityTransition,
  verificationBody, nonConformityBody, inspectionBody,
} from '../domain/lifecycle.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['quality', 'safety']);
const SEVERITIES = new Set(['minor', 'major', 'critical']);
const VERIFICATION_STATUSES = new Set(['pending', 'accepted', 'rejected']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** operationId: listMyVerifications — the viewer org's decision queue. */
export async function listMyVerifications({ viewer, store, query }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:quality:verify')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const errors = {};
  if (query?.status !== undefined && !VERIFICATION_STATUSES.has(query.status)) {
    errors.status = 'pending, accepted or rejected';
  }
  if (query?.project !== undefined && !UUID.test(query.project)) errors.project = 'a project id';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const { items, nextCursor } = await store.listMyVerifications({
    orgId: viewer.orgId,
    // The queue defaults to what still needs a decision.
    status: query?.status ?? 'pending',
    projectId: query?.project ?? null,
    cursor: query?.cursor ?? null,
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(verificationBody), next_cursor: nextCursor } };
}

/** operationId: acceptVerification — human-only; pending → accepted. */
export async function acceptVerification({ viewer, store, verificationId }) {
  return decideVerification({ viewer, store, verificationId, action: 'accept', note: null });
}

/** operationId: rejectVerification — human-only; pending → rejected, reason required. */
export async function rejectVerification({ viewer, store, verificationId, body }) {
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!note) {
    // The DB CHECK (status <> 'rejected' OR reason NOT NULL) backs this.
    throw new ProblemError('validation_failed', null, { errors: { note: 'a rejection carries its reason' } });
  }
  return decideVerification({ viewer, store, verificationId, action: 'reject', note });
}

async function decideVerification({ viewer, store, verificationId, action, note }) {
  requireActiveOrg(viewer);
  if (viewer.channel === 'mcp') {
    // x-human-only: accepting work is a human act, never an agent's (doc 19).
    throw new ProblemError('forbidden', 'deciding a verification is human-only', { reason: 'human_only' });
  }
  if (!viewer.has('org:quality:verify')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const vr = await store.getVerification(verificationId);
  if (!vr) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: vr.project_id });

  // Relationship: client chain of the task's contract | invited inspector.
  const related = (await store.isClientChain(viewer.orgId, { taskId: vr.task_id, projectId: vr.project_id }))
    || (await store.isInvitedInspector(vr.project_id, viewer.orgId));
  if (!related) {
    throw new ProblemError('forbidden', 'only the client chain above the task or an invited inspector decides', { reason: 'relationship' });
  }
  if (viewer.orgId === vr.requested_by_org_id) {
    // D-31: never the organisation whose report marked the row done (check 8g).
    throw new ProblemError('forbidden', 'an organisation never verifies its own work', { reason: 'relationship' });
  }
  const outcome = verificationTransition(vr.status, action);
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const actor = await requireActor(store, viewer);
  const decided = await store.decideVerification({
    verificationId,
    status: outcome.to,
    reason: note,
    deciderOrgId: viewer.orgId,
    deciderPersonId: actor.id,
    projectId: vr.project_id,
    taskId: vr.task_id,
    actor: actorOf(actor, viewer),
  });
  if (!decided) throw new ProblemError('invalid_transition', 'someone decided this verification first');
  return { status: 200, body: verificationBody(decided) };
}

/** operationId: raiseNonConformity — client id = idempotency key. */
export async function raiseNonConformity({ viewer, store, projectId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:quality:inspect')) throw new ProblemError('forbidden', null, { reason: 'role' });
  await requireParticipant({ viewer, store, projectId });

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (body?.kind !== undefined && !KINDS.has(body.kind)) errors.kind = 'quality or safety';
  if (!SEVERITIES.has(body?.severity)) errors.severity = 'minor, major or critical';
  if (typeof body?.description !== 'string' || !body.description.trim()) errors.description = 'required';
  const photos = body?.photo_document_ids ?? [];
  if (!Array.isArray(photos) || photos.some((d) => !UUID.test(d ?? ''))) {
    errors.photo_document_ids = 'a list of document ids';
  }
  if (body?.task_id !== undefined && body?.task_id !== null && !UUID.test(body.task_id)) errors.task_id = 'a task id';
  if (body?.assigned_to_org_id !== undefined && body?.assigned_to_org_id !== null && !UUID.test(body.assigned_to_org_id)) {
    errors.assigned_to_org_id = 'an organisation id';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = await requireActor(store, viewer);

  // Client-supplied id is the idempotency key: an identical replay answers
  // the row it already made; a stolen id answers 409.
  const existing = await store.getNonConformity(body.id);
  if (existing) {
    if (existing.raised_by_org_id === viewer.orgId
        && existing.raised_by_person_id === actor.id
        && existing.project_id === projectId) {
      return { status: 201, body: nonConformityBody(existing) };
    }
    throw new ProblemError('idempotency_mismatch', 'this id was already used by a different request');
  }

  // The contract in breach follows from the task's branch (planning owns it).
  let taskId = body.task_id ?? null;
  let contractId = null;
  if (taskId) {
    const task = await store.getTask(taskId);
    if (!task || task.project_id !== projectId) {
      throw new ProblemError('validation_failed', null, { errors: { task_id: 'not a row of this project' } });
    }
    contractId = task.branch_contract_id ?? task.contract_id ?? null;
  }

  const created = await store.createNonConformity({
    id: body.id,
    projectId,
    taskId,
    contractId,
    kind: body.kind ?? 'quality',
    severity: body.severity,
    description: body.description.trim(),
    photoDocumentIds: [...new Set(photos)],
    assignedToOrgId: body.assigned_to_org_id ?? null,
    raisedByOrgId: viewer.orgId,
    raisedByPersonId: actor.id,
    actor: actorOf(actor, viewer),
  });
  return { status: 201, body: nonConformityBody(created) };
}

/** operationId: assignNonConformity — raiser | client chain; open|rejected_fix → assigned. */
export async function assignNonConformity({ viewer, store, nonconformityId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:quality:inspect')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const nc = await requireNonConformity({ viewer, store, nonconformityId });

  const isRaiser = viewer.orgId === nc.raised_by_org_id;
  const inChain = isRaiser || (await store.isClientChain(viewer.orgId, {
    taskId: nc.task_id, contractId: nc.contract_id, projectId: nc.project_id,
  }));
  if (!inChain) {
    throw new ProblemError('forbidden', 'only the raiser or the client chain assigns', { reason: 'relationship' });
  }

  // The openapi body is Decision{note} — it has no field naming the org, so
  // an optional assigned_to_org_id is accepted as a benign superset; absent,
  // the org named when the NC was raised stands. (Contract gap reported.)
  const assignedToOrgId = body?.assigned_to_org_id ?? nc.assigned_to_org_id ?? null;
  if (!assignedToOrgId) {
    throw new ProblemError('validation_failed', null, { errors: { assigned_to_org_id: 'name the organisation responsible for the fix' } });
  }
  if (!UUID.test(assignedToOrgId)) {
    throw new ProblemError('validation_failed', null, { errors: { assigned_to_org_id: 'an organisation id' } });
  }

  return transitionNonConformity({
    viewer, store, nc, action: 'assign',
    set: { assignedToOrgId },
    eventType: 'quality.nonconformity.assigned',
    note: noteOf(body),
  });
}

/** operationId: fixNonConformity — assignee only; assigned|rejected_fix → fixed. */
export async function fixNonConformity({ viewer, store, nonconformityId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:progress:report')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const nc = await requireNonConformity({ viewer, store, nonconformityId });
  if (viewer.orgId !== nc.assigned_to_org_id) {
    throw new ProblemError('forbidden', 'only the organisation assigned to fix it reports the fix', { reason: 'relationship' });
  }
  return transitionNonConformity({
    viewer, store, nc, action: 'fix',
    set: {},
    eventType: 'quality.nonconformity.fixed',
    note: noteOf(body),
  });
}

/** operationId: closeNonConformity — human-only; RAISING org only; fixed → closed. */
export async function closeNonConformity({ viewer, store, nonconformityId, body }) {
  requireActiveOrg(viewer);
  if (viewer.channel === 'mcp') {
    // x-human-only: closing a non-conformity is a human act (doc 19).
    throw new ProblemError('forbidden', 'closing a non-conformity is human-only', { reason: 'human_only' });
  }
  if (!viewer.has('org:quality:inspect')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const nc = await requireNonConformity({ viewer, store, nonconformityId });
  if (viewer.orgId !== nc.raised_by_org_id) {
    // Closure belongs to the raiser (DB CHECK 8h backs this — never fight it).
    throw new ProblemError('forbidden', 'only the raising organisation closes its non-conformity', { reason: 'relationship' });
  }
  return transitionNonConformity({
    viewer, store, nc, action: 'close',
    set: { closedByOrgId: viewer.orgId },
    eventType: 'quality.nonconformity.closed',
    note: noteOf(body),
  });
}

/** operationId: rejectFixNonConformity — raising org only; fixed → rejected_fix. */
export async function rejectFixNonConformity({ viewer, store, nonconformityId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:quality:inspect')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const nc = await requireNonConformity({ viewer, store, nonconformityId });
  if (viewer.orgId !== nc.raised_by_org_id) {
    throw new ProblemError('forbidden', 'only the raising organisation rejects the fix', { reason: 'relationship' });
  }
  return transitionNonConformity({
    viewer, store, nc, action: 'reject_fix',
    set: {},
    eventType: 'quality.nonconformity.fix_rejected',
    note: noteOf(body),
  });
}

/** operationId: recordInspection — invited inspector | client chain; ledger only. */
export async function recordInspection({ viewer, store, projectId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:quality:inspect')) throw new ProblemError('forbidden', null, { reason: 'role' });
  await requireParticipant({ viewer, store, projectId });

  const related = (await store.isInvitedInspector(projectId, viewer.orgId))
    || (await store.isProjectClient(projectId, viewer.orgId));
  if (!related) {
    throw new ProblemError('forbidden', 'only an invited inspector or a client on the project inspects', { reason: 'relationship' });
  }

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (body?.kind !== undefined && !KINDS.has(body.kind)) errors.kind = 'quality or safety';
  if (!DATE_ONLY.test(body?.date ?? '')) errors.date = 'YYYY-MM-DD required';
  const checklist = body?.checklist ?? [];
  if (!Array.isArray(checklist)
      || checklist.some((c) => !c || typeof c !== 'object'
        || typeof c.item !== 'string' || typeof c.ok !== 'boolean'
        || (c.note !== undefined && typeof c.note !== 'string'))) {
    errors.checklist = 'a list of {item, ok, note?}';
  }
  if (body?.findings !== undefined && body?.findings !== null && typeof body.findings !== 'string') {
    errors.findings = 'text';
  }
  const taskIds = body?.task_ids ?? [];
  if (!Array.isArray(taskIds) || taskIds.some((t) => !UUID.test(t ?? ''))) {
    errors.task_ids = 'a list of task ids';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  if (taskIds.length) {
    const known = await store.tasksOfProject(projectId, taskIds);
    const missing = taskIds.filter((t) => !known.has(t));
    if (missing.length) {
      throw new ProblemError('validation_failed', null, { errors: { task_ids: `not rows of this project: ${missing.join(', ')}` } });
    }
  }

  const actor = await requireActor(store, viewer);
  const existing = await store.getInspection(body.id);
  if (existing) {
    if (existing.inspector_org_id === viewer.orgId && existing.project_id === projectId) {
      return { status: 201, body: inspectionBody(existing) };
    }
    throw new ProblemError('idempotency_mismatch', 'this id was already used by a different request');
  }

  const created = await store.createInspection({
    id: body.id,
    projectId,
    inspectorOrgId: viewer.orgId,
    kind: body.kind ?? 'quality',
    date: body.date,
    checklist: checklist.map((c) => ({ item: c.item, ok: c.ok, ...(c.note !== undefined ? { note: c.note } : {}) })),
    findings: body.findings ?? null,
    taskIds: [...new Set(taskIds)],
    actor: actorOf(actor, viewer),
  });
  return { status: 201, body: inspectionBody(created) };
}

// ── shared helpers ───────────────────────────────────────────────────────

async function transitionNonConformity({ viewer, store, nc, action, set, eventType, note }) {
  const outcome = nonConformityTransition(nc.status, action);
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionNonConformity({
    nonconformityId: nc.id,
    from: nc.status,
    to: outcome.to,
    set,
    eventType,
    note,
    projectId: nc.project_id,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this non-conformity first');
  return { status: 200, body: nonConformityBody(updated) };
}

/** Load an NC with existence hiding: a non-participant gets 404, not 403. */
async function requireNonConformity({ viewer, store, nonconformityId }) {
  const nc = await store.getNonConformity(nonconformityId);
  if (!nc) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: nc.project_id });
  return nc;
}

function requireActiveOrg(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

function seesWholeOrg(viewer) {
  return viewer.orgRole === 'admin' || viewer.orgRole === 'manager';
}

async function requireActor(store, viewer) {
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
  return person;
}

/** relationship: project.participant (∧ staffing for non-managers) — doc 16 §4. */
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

function actorOf(person, viewer) {
  return { personId: person.id, orgId: viewer.orgId, orgRole: viewer.orgRole, channel: viewer.channel };
}

function noteOf(body) {
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  return note || null;
}

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}
